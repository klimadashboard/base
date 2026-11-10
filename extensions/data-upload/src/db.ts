import type { EndpointExtensionContext } from "@directus/extensions";
import type { SchemaOverview } from "@directus/types";
import type { Knex } from "knex";
import type { Analysis } from "./analyze";
import { getDataset, normalisePeriod, type Dataset } from "./datasets";
import type { Target } from "./access";

export const SUBMISSIONS_TABLE = "data_upload_submissions";
export const LOGINS_TABLE = "data_upload_logins";
export const RATE_TABLE = "data_upload_rate";

export type SubmissionStatus = "draft" | "pending" | "applied" | "rejected" | "failed";

export type PlannedRow = {
	period: string | number;
	category: string;
	value: number;
	existingId: number | null;
	oldValue: number | null;
	action: "create" | "update" | "unchanged";
};

export type PlannedTable = {
	dataset: string;
	label: string;
	collection: string;
	unit: string;
	/** fixed key fields written with every row, e.g. { region: "08111", country: "DE" } */
	key: Record<string, string | number>;
	source: string;
	notes: string;
	rows: PlannedRow[];
	rejected: string[]; // rows dropped by validation, human-readable
};

export type Plan = {
	summary: string;
	warnings: string[];
	tables: PlannedTable[];
	unmatched: { notes: string }[];
};

export async function ensureTables(db: Knex) {
	if (!(await db.schema.hasTable(LOGINS_TABLE))) {
		await db.schema.createTable(LOGINS_TABLE, (t) => {
			t.string("token_hash", 64).primary();
			t.string("email").notNullable();
			t.timestamp("expires_at").notNullable();
			t.timestamp("used_at");
			t.timestamp("created_at").notNullable().defaultTo(db.fn.now());
		});
	}
	if (!(await db.schema.hasTable(RATE_TABLE))) {
		await db.schema.createTable(RATE_TABLE, (t) => {
			t.increments("id");
			t.string("key").notNullable();
			t.timestamp("at").notNullable().defaultTo(db.fn.now());
			t.index(["key", "at"]);
		});
	}
	if (await db.schema.hasTable(SUBMISSIONS_TABLE)) return;
	await db.schema.createTable(SUBMISSIONS_TABLE, (t) => {
		t.uuid("id").primary();
		t.string("region").notNullable();
		t.string("region_label");
		t.string("status").notNullable();
		t.string("uploaded_by");
		t.text("description");
		t.json("files");
		t.json("plan");
		t.text("error");
		t.string("slack_channel");
		t.string("slack_ts");
		t.string("decided_by");
		t.timestamp("created_at").notNullable().defaultTo(db.fn.now());
		t.timestamp("decided_at");
	});
}

/**
 * Counts one attempt for `key` and reports whether it exceeds `max` per window.
 * Stored in the database so the limit holds across all Directus instances and restarts.
 */
export async function overLimit(db: Knex, key: string, max: number, windowMs: number) {
	const since = new Date(Date.now() - windowMs);
	const row = await db(RATE_TABLE).where({ key }).where("at", ">", since).count({ n: "*" }).first();
	if (Number(row?.n ?? 0) >= max) return true;
	await db(RATE_TABLE).insert({ key, at: new Date() });
	if (Math.random() < 0.02) await db(RATE_TABLE).where("at", "<", new Date(Date.now() - 2 * 24 * 3600 * 1000)).delete();
	return false;
}

type ServiceCtor = EndpointExtensionContext["services"]["ItemsService"];

function baseFilter(key: Record<string, string | number>) {
	return Object.entries(key).map(([k, v]) => ({ [k]: { _eq: v } }));
}

/** Latest rows per dataset, given to Claude as context for plausibility checks. */
export async function loadRecentRows(ItemsService: ServiceCtor, schema: SchemaOverview, target: Target, datasets: Dataset[]) {
	const out: Record<string, unknown[]> = {};
	for (const d of datasets) {
		const svc = new ItemsService(d.collection, { schema, accountability: null });
		const rows = await svc.readByQuery({
			filter: { _and: baseFilter(d.fixedFields(target)) },
			sort: [`-${d.periodField}`],
			limit: d.categories.length * 3,
			fields: [d.periodField, "category", "value"],
		});
		out[d.id] = rows.map((r) => ({ period: r[d.periodField], category: r.category, value: r.value }));
	}
	return out;
}

/** Validate Claude's output against the dataset definitions and diff it against the DB. */
export async function buildPlan(
	ItemsService: ServiceCtor,
	schema: SchemaOverview,
	target: Target,
	allowed: string[],
	analysis: Analysis,
): Promise<Plan> {
	const plan: Plan = { summary: analysis.summary, warnings: [...analysis.warnings], tables: [], unmatched: [] };

	for (const t of analysis.tables) {
		const d = getDataset(t.dataset);
		if (!d || !allowed.includes(d.id)) {
			plan.unmatched.push({ notes: t.notes });
			continue;
		}

		const rejected: string[] = [];
		const seen = new Map<string, { period: string | number; category: string; value: number }>();
		for (const r of t.rows) {
			const period = normalisePeriod(d, r.period);
			if (period === null) {
				rejected.push(`${r.period} / ${r.category}: ungültiger Zeitraum`);
				continue;
			}
			if (!d.categories.includes(r.category)) {
				rejected.push(`${r.period} / ${r.category}: unbekannte Kategorie`);
				continue;
			}
			if (!Number.isFinite(r.value)) {
				rejected.push(`${r.period} / ${r.category}: kein gültiger Zahlenwert`);
				continue;
			}
			const key = `${period}|${r.category}`;
			if (seen.has(key) && seen.get(key)!.value !== r.value) {
				rejected.push(`${period} / ${r.category}: widersprüchliche doppelte Werte`);
				continue;
			}
			seen.set(key, { period, category: r.category, value: r.value });
		}

		const rows = [...seen.values()];
		const existing = await loadExisting(ItemsService, schema, d, d.fixedFields(target), rows.map((r) => r.period));
		const source = t.source.trim() || (await lastSource(ItemsService, schema, d, target)) || `${target.name} (Daten-Upload)`;

		plan.tables.push({
			dataset: d.id,
			label: d.label,
			collection: d.collection,
			unit: d.unit,
			key: d.fixedFields(target),
			source,
			notes: t.notes,
			rejected,
			rows: rows
				.map((r) => {
					const ex = existing.get(`${r.period}|${r.category}`);
					return {
						...r,
						existingId: ex?.id ?? null,
						oldValue: ex?.value ?? null,
						action: !ex ? "create" : ex.value === r.value ? "unchanged" : "update",
					} as PlannedRow;
				})
				.sort((a, b) => String(a.period).localeCompare(String(b.period)) || a.category.localeCompare(b.category)),
		});
	}
	return plan;
}

/** Source of the newest existing row, so a file without a source line keeps the established one. */
async function lastSource(ItemsService: ServiceCtor, schema: SchemaOverview, d: Dataset, target: Target) {
	const svc = new ItemsService(d.collection, { schema, accountability: null });
	const [row] = await svc.readByQuery({
		filter: { _and: [...baseFilter(d.fixedFields(target)), { source: { _nnull: true } }] },
		sort: [`-${d.periodField}`],
		limit: 1,
		fields: ["source"],
	});
	return (row?.source as string | undefined)?.trim() || null;
}

async function loadExisting(
	ItemsService: ServiceCtor,
	schema: SchemaOverview,
	d: Dataset,
	key: Record<string, string | number>,
	periods: (string | number)[],
	knex?: Knex,
) {
	const map = new Map<string, { id: number; value: number | null }>();
	if (periods.length === 0) return map;
	const svc = new ItemsService(d.collection, { schema, knex, accountability: null });
	const rows = await svc.readByQuery({
		filter: { _and: [...baseFilter(key), { [d.periodField]: { _in: [...new Set(periods)] } }] },
		fields: ["id", d.periodField, "category", "value"],
		limit: -1,
	});
	for (const r of rows) {
		// Directus returns dates as "YYYY-MM-DD" and integers as numbers, matching normalisePeriod()
		map.set(`${r[d.periodField]}|${r.category}`, { id: r.id, value: r.value === null ? null : Number(r.value) });
	}
	return map;
}

/**
 * Write a plan inside one transaction, using the region keys stored in the plan
 * (exactly what was approved). Re-reads existing rows first so that changes made
 * between analysis and approval are respected.
 */
export async function applyPlan(ItemsService: ServiceCtor, schema: SchemaOverview, db: Knex, plan: Plan) {
	const counts = { created: 0, updated: 0, unchanged: 0 };
	const today = new Date().toISOString().slice(0, 10);

	await db.transaction(async (trx) => {
		for (const t of plan.tables) {
			const d = getDataset(t.dataset);
			if (!d) continue;
			const svc = new ItemsService(d.collection, { schema, knex: trx, accountability: null });
			const existing = await loadExisting(ItemsService, schema, d, t.key, t.rows.map((r) => r.period), trx);
			const stamp = d.updateField
				? { [d.updateField.name]: d.updateField.type === "date" ? today : `${today}T00:00:00` }
				: {};

			for (const r of t.rows) {
				const ex = existing.get(`${r.period}|${r.category}`);
				if (ex && ex.value === r.value) {
					counts.unchanged++;
				} else if (ex) {
					await svc.updateOne(ex.id, { value: r.value, source: t.source, ...stamp });
					counts.updated++;
				} else {
					await svc.createOne({
						...t.key,
						[d.periodField]: r.period,
						category: r.category,
						value: r.value,
						source: t.source,
						...stamp,
					});
					counts.created++;
				}
			}
		}
	});
	return counts;
}
