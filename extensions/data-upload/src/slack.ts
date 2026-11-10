import crypto from "node:crypto";
import type { Plan } from "./db";

const API = "https://slack.com/api/";
const MAX_LINES_PER_TABLE = 25;

export async function slackCall(token: string, method: string, body: Record<string, unknown>) {
	const res = await fetch(API + method, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
	if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`);
	return json;
}

/** https://api.slack.com/authentication/verifying-requests-from-slack */
export function verifySlackSignature(secret: string, headers: Record<string, unknown>, rawBody: string) {
	const ts = String(headers["x-slack-request-timestamp"] ?? "");
	const sig = String(headers["x-slack-signature"] ?? "");
	if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
	const expected = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
	const a = Buffer.from(expected);
	const b = Buffer.from(sig);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Escape text from uploaders or Claude so it can't inject mentions (<!channel>) or disguised links. */
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("de-DE"));

function tableLines(plan: Plan) {
	return plan.tables.map((t) => {
		const created = t.rows.filter((r) => r.action === "create").length;
		const updated = t.rows.filter((r) => r.action === "update").length;
		const unchanged = t.rows.length - created - updated;
		const changes = t.rows.filter((r) => r.action !== "unchanged");
		const lines = changes.slice(0, MAX_LINES_PER_TABLE).map((r) => {
			const label = esc(`${r.period}  ${r.category}`.padEnd(32));
			return r.action === "create" ? `+ ${label} ${fmt(r.value)}` : `~ ${label} ${fmt(r.oldValue)} → ${fmt(r.value)}`;
		});
		if (changes.length > MAX_LINES_PER_TABLE) lines.push(`… und ${changes.length - MAX_LINES_PER_TABLE} weitere`);
		const key = Object.entries(t.key).map(([k, v]) => `${k}=${v}`).join(", ");
		let text = `*${t.label}* → \`${t.collection}\` (${key}, ${t.unit})\n${created} neu · ${updated} geändert · ${unchanged} unverändert · Quelle: ${esc(t.source)}`;
		if (t.notes) text += `\n_${esc(t.notes)}_`;
		if (lines.length) text += "\n```" + lines.join("\n") + "```";
		if (t.rejected.length) text += `\n:warning: ${t.rejected.length} Zeile(n) verworfen: ${esc(t.rejected.slice(0, 5).join("; "))}`;
		return text.slice(0, 2900);
	});
}

export function hasChanges(plan: Plan) {
	return plan.tables.some((t) => t.rows.some((r) => r.action !== "unchanged"));
}

export function submissionBlocks(opts: {
	submissionId: string;
	regionLabel: string;
	uploadedBy: string | null;
	description: string;
	plan: Plan;
	fileLinks: { name: string; url: string }[];
	reviewUrl: string;
}) {
	const { submissionId, regionLabel, uploadedBy, description, plan, fileLinks, reviewUrl } = opts;
	const blocks: Record<string, unknown>[] = [
		{ type: "header", text: { type: "plain_text", text: `📥 Neue Daten: ${regionLabel}`.slice(0, 150) } },
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `${uploadedBy ? `Von ${esc(uploadedBy)}:\n` : ""}> ${esc(description) || "(keine Beschreibung)"}\n\n${esc(plan.summary)}`.slice(0, 2900),
			},
		},
	];
	for (const text of tableLines(plan)) blocks.push({ type: "section", text: { type: "mrkdwn", text } });
	for (const u of plan.unmatched) {
		blocks.push({
			type: "section",
			text: { type: "mrkdwn", text: `:grey_question: *Kein passender Datensatz* – bitte manuell prüfen.\n_${esc(u.notes)}_`.slice(0, 2900) },
		});
	}
	if (plan.warnings.length) {
		blocks.push({
			type: "section",
			text: { type: "mrkdwn", text: plan.warnings.map((w) => `:warning: ${esc(w)}`).join("\n").slice(0, 2900) },
		});
	}
	blocks.push({
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: [`<${reviewUrl}|Alle Werte ansehen>`, ...fileLinks.map((f) => `<${f.url}|${esc(f.name).replace(/\|/g, "¦")}>`)].join(" · ").slice(0, 2900),
			},
		],
	});
	if (hasChanges(plan)) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "approve",
					style: "primary",
					text: { type: "plain_text", text: "Übernehmen" },
					value: submissionId,
					confirm: {
						title: { type: "plain_text", text: "In Datenbank schreiben?" },
						text: { type: "plain_text", text: "Die Werte werden direkt in die Produktionsdatenbank geschrieben." },
						confirm: { type: "plain_text", text: "Übernehmen" },
						deny: { type: "plain_text", text: "Abbrechen" },
					},
				},
				{
					type: "button",
					action_id: "reject",
					style: "danger",
					text: { type: "plain_text", text: "Ablehnen" },
					value: submissionId,
				},
			],
		});
	}
	return blocks;
}

/** Replace the action buttons of a submission message with a status line. */
export function resolvedBlocks(original: Record<string, unknown>[], status: string) {
	return [
		...original.filter((b) => b.type !== "actions"),
		{ type: "context", elements: [{ type: "mrkdwn", text: status }] },
	];
}
