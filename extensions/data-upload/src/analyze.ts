import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";
import type { Dataset } from "./datasets";
import type { Target } from "./access";

export type UploadedFile = {
	filename: string;
	mimetype: string;
	buffer: Buffer;
};

export type ExtractedRow = { period: string; category: string; value: number };

export type ExtractedTable = {
	dataset: string; // dataset id or "unbekannt"
	source: string;
	notes: string;
	rows: ExtractedRow[];
};

export type Analysis = {
	summary: string;
	warnings: string[];
	tables: ExtractedTable[];
};

const MODEL = "claude-opus-5-5";
// Spreadsheets are passed as CSV text. Above this we refuse rather than truncate.
const MAX_TEXT_CHARS = 600_000;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const SYSTEM_PROMPT = `You extract statistical data that a city administration uploads for Klimadashboard (klimadashboard.org), a public climate dashboard, and map it onto Klimadashboard's database.

You receive the uploader's short description, the files (spreadsheets as CSV text, screenshots as images, PDFs as documents), the list of target datasets this uploader may update (with mapping rules), and the most recent rows already in the database for each dataset.

Your job:
1. Identify which target dataset(s) the uploaded data belongs to. Use the description as a hint, but trust the file contents.
2. Extract every data point as {period, category, value}, following the dataset's mapping rules exactly. Numbers in German formatting ("167 449", "1.234,5") must be converted to plain numbers. Never round, estimate or fill gaps; omit what is not in the files.
3. Compare against the existing rows: watch for unit mismatches (factor 1000), cumulative vs. monthly values, and suspicious jumps. Report anything odd in warnings.
4. The region is fixed by the uploader (see "Region"); never extract or guess it. Files often carry no region label at all, which is fine. Only if a file explicitly shows a different or larger area (e.g. Baden-Württemberg, Region Stuttgart, several districts side by side), extract just the uploader's own area if it is clearly separable, otherwise extract nothing from that table and say why in warnings.
5. If (part of) the data matches no target dataset, return it as one table with dataset "unbekannt", rows empty, and describe in notes what it contains so a human can handle it.

Field rules:
- source: the publishing institution only if the file states it explicitly, otherwise "".
- notes: short German explanation of how you mapped this table (e.g. which columns you summed).
- summary: 1-3 German sentences for the uploader and the Klimadashboard team: what was uploaded, which period(s), which dataset.
- warnings: German, one item per concrete issue. Empty array if none.`;

function buildSchema(datasetIds: string[]) {
	return {
		type: "object",
		additionalProperties: false,
		required: ["summary", "warnings", "tables"],
		properties: {
			summary: { type: "string" },
			warnings: { type: "array", items: { type: "string" } },
			tables: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["dataset", "source", "notes", "rows"],
					properties: {
						dataset: { type: "string", enum: [...datasetIds, "unbekannt"] },
						source: { type: "string" },
						notes: { type: "string" },
						rows: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["period", "category", "value"],
								properties: {
									period: { type: "string" },
									category: { type: "string" },
									value: { type: "number" },
								},
							},
						},
					},
				},
			},
		},
	};
}

function spreadsheetToText(file: UploadedFile): string {
	const wb = XLSX.read(file.buffer, { type: "buffer", cellDates: true });
	return wb.SheetNames.map((name) => {
		const ws = wb.Sheets[name];
		const csv = ws ? XLSX.utils.sheet_to_csv(ws, { blankrows: false }) : "";
		return `## Tabellenblatt "${name}"\n${csv}`;
	}).join("\n\n");
}

function isSpreadsheet(f: UploadedFile) {
	return /\.(xlsx|xlsm|xls|ods)$/i.test(f.filename) || f.mimetype.includes("spreadsheet") || f.mimetype.includes("excel");
}

function isText(f: UploadedFile) {
	return /\.(csv|tsv|txt)$/i.test(f.filename) || f.mimetype.startsWith("text/");
}

export function fileToBlocks(file: UploadedFile): Anthropic.Beta.BetaContentBlockParam[] {
	const label: Anthropic.Beta.BetaContentBlockParam = { type: "text", text: `Datei: ${file.filename}` };
	if (IMAGE_TYPES.includes(file.mimetype as ImageType)) {
		return [
			label,
			{
				type: "image",
				source: { type: "base64", media_type: file.mimetype as ImageType, data: file.buffer.toString("base64") },
			},
		];
	}
	if (file.mimetype === "application/pdf" || /\.pdf$/i.test(file.filename)) {
		return [
			label,
			{
				type: "document",
				source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") },
			},
		];
	}
	if (isSpreadsheet(file)) {
		return [{ type: "text", text: `Datei: ${file.filename}\n\n${spreadsheetToText(file)}` }];
	}
	if (isText(file)) {
		return [{ type: "text", text: `Datei: ${file.filename}\n\n${file.buffer.toString("utf8")}` }];
	}
	throw new UserError(`Dateityp wird nicht unterstützt: ${file.filename}. Erlaubt sind Excel, CSV, PDF und Bilder (PNG/JPG).`);
}

export class UserError extends Error {}

export async function analyzeUpload(opts: {
	apiKey: string;
	/** Needed for user-level keys (sk-ant-usr-…) that aren't scoped to a workspace. */
	workspaceId?: string;
	target: Target;
	datasets: Dataset[];
	existing: Record<string, unknown[]>;
	description: string;
	files: UploadedFile[];
}): Promise<Analysis> {
	const { target, datasets, existing, description, files } = opts;

	const fileBlocks = files.flatMap(fileToBlocks);
	const textChars = fileBlocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
	if (textChars > MAX_TEXT_CHARS) {
		throw new UserError(
			"Die Tabelle ist zu groß für die automatische Auswertung. Bitte nur die relevanten Tabellenblätter bzw. Zeilen hochladen.",
		);
	}

	const datasetInfo = datasets
		.map(
			(d) =>
				`### ${d.id} — ${d.label}\nUnit: ${d.unit}\nPeriod format: ${
					d.periodKind === "month_end" ? "YYYY-MM-DD (last day of month)" : "YYYY"
				}\nAllowed categories: ${d.categories.join(", ")}\n${d.guidance}\nMost recent rows in the database:\n${JSON.stringify(
					existing[d.id] ?? [],
				)}`,
		)
		.join("\n\n");

	const client = new Anthropic({
		apiKey: opts.apiKey,
		defaultHeaders: opts.workspaceId ? { "anthropic-workspace-id": opts.workspaceId } : undefined,
	});

	const stream = client.beta.messages.stream({
		model: MODEL,
		max_tokens: 64000,
		betas: ["server-side-fallback-2026-07-01"],
		fallbacks: "default",
		thinking: { type: "adaptive" },
		output_config: {
			effort: "medium",
			format: { type: "json_schema", schema: buildSchema(datasets.map((d) => d.id)) },
		},
		system: SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `Region: ${target.label}\nToday: ${new Date().toISOString().slice(0, 10)}\n\n# Target datasets\n\n${datasetInfo}`,
					},
					...fileBlocks,
					{ type: "text", text: `Beschreibung des Uploads: »${description || "(keine)"}«` },
				],
			},
		],
	});
	const response = await stream.finalMessage();

	if (response.stop_reason === "refusal") {
		throw new Error(`Claude refused the request (${response.stop_details?.category ?? "unknown"})`);
	}
	if (response.stop_reason === "max_tokens") {
		throw new UserError("Die Datei enthält zu viele Werte für eine Auswertung. Bitte in kleineren Teilen hochladen.");
	}
	const text = response.content.find((b) => b.type === "text");
	if (!text || text.type !== "text") throw new Error("Claude returned no text block");
	return JSON.parse(text.text) as Analysis;
}
