import { defineEndpoint } from "@directus/extensions-sdk";
import type { IncomingMessage } from "node:http";
import Busboy from "busboy";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { grantsFor, resolveTargets, type Grant } from "./access";
import { analyzeUpload, fileToBlocks, UserError, type UploadedFile } from "./analyze";
import {
	hashToken,
	issueSession,
	MAGIC_LINK_TTL_MS,
	newMagicToken,
	normaliseEmail,
	reviewSignature,
	verifyReviewSignature,
	verifySession,
} from "./auth";
import { getDataset } from "./datasets";
import { applyPlan, buildPlan, ensureTables, LOGINS_TABLE, loadRecentRows, overLimit, SUBMISSIONS_TABLE, type Plan } from "./db";
import { decisionEmail, magicLinkEmail, REVIEW_JS, reviewPage, UPLOAD_JS, uploadPage } from "./page";
import { hasChanges, resolvedBlocks, slackCall, submissionBlocks, verifySlackSignature } from "./slack";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MINUTE = 60 * 1000;
/** Analyses per address and day; each one is a paid Claude request. */
const MAX_ANALYSES_PER_DAY = 20;

export default defineEndpoint({
	id: "data-upload",
	handler: (router, { services, database, getSchema, env, logger }) => {
		const { ItemsService, FilesService, MailService } = services;
		const secret = String(env.SECRET ?? "");
		const publicUrl = String(env.PUBLIC_URL ?? "").replace(/\/$/, "");
		const mount = `${new URL(publicUrl || "http://localhost").pathname.replace(/\/$/, "")}/data-upload/`;
		const slackToken = env.SLACK_BOT_TOKEN as string | undefined;
		const slackChannel = env.DATA_UPLOAD_SLACK_CHANNEL as string | undefined;
		const slackSigningSecret = env.SLACK_SIGNING_SECRET as string | undefined;
		const anthropicKey = env.ANTHROPIC_API_KEY as string | undefined;
		const anthropicWorkspace = env.ANTHROPIC_WORKSPACE_ID as string | undefined;
		/** directus_folders.id for uploaded originals; the Public policy must not be able to read this folder. */
		const uploadFolder = env.DATA_UPLOAD_FOLDER as string | undefined;

		// Internal tables (plain SQL, invisible in the admin); data_upload_access is a regular collection.
		let ready: Promise<unknown> | null = null;
		const tablesReady = () =>
			(ready ??= ensureTables(database).catch((err) => {
				ready = null;
				logger.error(err, "[data-upload] could not create tables");
				throw err;
			}));

		const db = () => database(SUBMISSIONS_TABLE);
		const parseJson = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

		/**
		 * Resolves the session and loads the address's grants on every request,
		 * so deactivating a row in data_upload_access revokes access immediately.
		 */
		async function auth(req: IncomingMessage, res: { status(code: number): { json(body: unknown): unknown } }) {
			const email = verifySession(secret, req.headers["x-upload-token"] as string | undefined);
			await tablesReady();
			const grants = email ? await grantsFor(database, email) : [];
			if (!email || grants.length === 0) {
				res.status(401).json({ error: "Bitte erneut anmelden." });
				return null;
			}
			const grant = (region: unknown) => grants.find((g) => g.region === region);
			return { email, grants, grant, regionIds: grants.map((g) => g.region) };
		}

		async function targetFor(grant: Grant) {
			const [target] = await resolveTargets(ItemsService, await getSchema(), [grant.region]);
			if (!target) throw new Error(`Region ${grant.region} not found`);
			return target;
		}

		/* ------------------------------ upload UI ------------------------------ */

		router.get("/", (_req, res) => {
			res.type("html").send(uploadPage(mount));
		});

		router.get("/app.js", (_req, res) => {
			res.type("application/javascript").set("Cache-Control", "no-cache").send(UPLOAD_JS);
		});

		router.get("/review.js", (_req, res) => {
			res.type("application/javascript").set("Cache-Control", "no-cache").send(REVIEW_JS);
		});

		/** Step 1: send a magic link. Same answer whether or not the address is approved (no enumeration). */
		router.post("/api/login", async (req, res) => {
			const email = normaliseEmail(String(req.body?.email ?? ""));
			if (!email.includes("@")) return res.status(400).json({ error: "Bitte eine gültige E-Mail-Adresse eingeben." });
			await tablesReady();
			if (
				(await overLimit(database, `login-ip:${req.ip}`, 10, 15 * MINUTE)) ||
				(await overLimit(database, `login-email:${email}`, 5, 15 * MINUTE))
			) {
				return res.status(429).json({ error: "Zu viele Versuche. Bitte in 15 Minuten erneut probieren." });
			}
			const ok = { data: { message: "Falls die Adresse freigeschaltet ist, ist ein Anmeldelink unterwegs. Bitte Postfach prüfen." } };
			if ((await grantsFor(database, email)).length === 0) {
				logger.info("[data-upload] magic link requested for non-approved address");
				return res.json(ok);
			}
			const { token, hash } = newMagicToken();
			await database(LOGINS_TABLE).insert({
				token_hash: hash,
				email,
				expires_at: new Date(Date.now() + MAGIC_LINK_TTL_MS),
			});
			try {
				const mail = new MailService({ schema: await getSchema(), knex: database, accountability: null });
				const link = `${publicUrl}/data-upload/?login=${token}`;
				await mail.send({
					to: email,
					subject: "Ihr Anmeldelink für den Klimadashboard-Daten-Upload",
					html: magicLinkEmail(link, MAGIC_LINK_TTL_MS / 60000),
				});
			} catch (err) {
				logger.error(err, "[data-upload] sending magic link failed");
				return res.status(500).json({ error: "E-Mail konnte nicht verschickt werden. Bitte team@klimadashboard.org kontaktieren." });
			}
			res.json(ok);
		});

		/**
		 * Step 2: the page exchanges the link token for a session via POST (not on GET),
		 * so mail scanners that prefetch links can't burn the single-use token.
		 */
		router.post("/api/verify", async (req, res) => {
			await tablesReady();
			if (await overLimit(database, `verify-ip:${req.ip}`, 30, 15 * MINUTE)) {
				return res.status(429).json({ error: "Zu viele Versuche. Bitte in 15 Minuten erneut probieren." });
			}
			const hash = hashToken(String(req.body?.token ?? ""));
			const used = await database(LOGINS_TABLE)
				.where({ token_hash: hash })
				.whereNull("used_at")
				.where("expires_at", ">", new Date())
				.update({ used_at: new Date() });
			const row = used ? await database(LOGINS_TABLE).where({ token_hash: hash }).first() : null;
			if (!row || (await grantsFor(database, row.email)).length === 0) {
				return res.status(401).json({ error: "Der Link ist abgelaufen oder wurde schon benutzt. Bitte einen neuen anfordern." });
			}
			res.json({ token: issueSession(secret, row.email), email: row.email });
		});

		/** Regions (and their datasets) the signed-in address may upload for. */
		router.get("/api/me", async (req, res) => {
			const session = await auth(req, res);
			if (!session) return;
			const targets = await resolveTargets(ItemsService, await getSchema(), session.regionIds);
			res.json({
				data: {
					email: session.email,
					regions: targets.map((t) => ({
						id: t.id,
						label: t.label,
						datasets: session.grant(t.id)!.datasets.map((id) => ({ id, label: getDataset(id)!.label })),
					})),
				},
			});
		});

		/** Uploads for all regions of the address, so colleagues see each other's uploads. */
		router.get("/api/submissions", async (req, res) => {
			const session = await auth(req, res);
			if (!session) return;
			const rows = await db()
				.whereIn("region", session.regionIds)
				.whereNot({ status: "discarded" })
				.orderBy("created_at", "desc")
				.limit(20)
				.select("id", "region_label", "status", "uploaded_by", "description", "created_at", "decided_at", "error");
			res.json({ data: rows });
		});

		router.get("/api/submissions/:id", async (req, res) => {
			const session = await auth(req, res);
			if (!session) return;
			const row = await db().where({ id: req.params.id }).whereIn("region", session.regionIds).first();
			if (!row) return res.status(404).json({ error: "Nicht gefunden." });
			res.json({ data: { ...row, plan: row.plan ? parseJson<Plan>(row.plan) : null, files: parseJson(row.files) } });
		});

		router.post("/api/analyze", async (req, res) => {
			const session = await auth(req, res);
			if (!session) return;
			if (!anthropicKey) return res.status(500).json({ error: "Server nicht konfiguriert (ANTHROPIC_API_KEY)." });
			if (!uploadFolder) return res.status(500).json({ error: "Server nicht konfiguriert (DATA_UPLOAD_FOLDER)." });
			const today = await db()
				.where({ uploaded_by: session.email })
				.where("created_at", ">", new Date(Date.now() - 24 * 60 * MINUTE))
				.count({ n: "*" })
				.first();
			if (Number(today?.n ?? 0) >= MAX_ANALYSES_PER_DAY) {
				return res.status(429).json({
					error: `Sie haben heute schon ${MAX_ANALYSES_PER_DAY} Uploads ausgewertet. Bitte morgen weitermachen oder team@klimadashboard.org schreiben.`,
				});
			}

			let region = "";
			let description = "";
			let files: UploadedFile[];
			try {
				({ region, description, files } = await readMultipart(req));
				// One grant: the region field may be missing (old tab); more than one: it must name a granted region.
				if (!region && session.grants.length === 1) region = session.grants[0]!.region;
				if (!session.grant(region)) throw new UserError("Für diese Region sind Sie nicht freigeschaltet.");
				if (files.length === 0) throw new UserError("Bitte mindestens eine Datei hochladen.");
				files.forEach(fileToBlocks); // fail fast on unsupported types
			} catch (err) {
				return res.status(400).json({ error: err instanceof UserError ? err.message : "Upload fehlgeschlagen." });
			}

			const grant = session.grant(region)!;
			const target = await targetFor(grant);
			const id = crypto.randomUUID();
			await db().insert({
				id,
				region: target.id,
				region_label: target.label,
				status: "analyzing",
				uploaded_by: session.email,
				description,
				files: JSON.stringify([]),
			});
			res.json({ data: { id, status: "analyzing" } });

			// Analysis can take a minute or two — run it after responding; the UI polls.
			(async () => {
				const schema = await getSchema();
				const fileRefs = await storeFiles(files, target.label, schema);
				await db().where({ id }).update({ files: JSON.stringify(fileRefs) });

				const datasets = grant.datasets.map(getDataset).filter((d) => !!d);
				const existing = await loadRecentRows(ItemsService, schema, target, datasets);
				const analysis = await analyzeUpload({ apiKey: anthropicKey, workspaceId: anthropicWorkspace, target, datasets, existing, description, files });
				const plan = await buildPlan(ItemsService, schema, target, grant.datasets, analysis);
				await db().where({ id }).update({ status: "draft", plan: JSON.stringify(plan) });
			})().catch(async (err) => {
				logger.error(err, `[data-upload] analysis ${id} failed`);
				const msg = err instanceof UserError ? err.message : "Die automatische Auswertung ist fehlgeschlagen. Das Team wurde informiert.";
				await db().where({ id }).update({ status: "error", error: msg });
				await notifyError(`Auswertung für ${target.label} fehlgeschlagen (${id}): ${String(err?.message ?? err)}`);
			});
		});

		router.post("/api/submissions/:id/submit", async (req, res) => {
			const session = await auth(req, res);
			if (!session) return;
			const row = await db().where({ id: req.params.id }).whereIn("region", session.regionIds).first();
			if (!row || row.status !== "draft") return res.status(409).json({ error: "Dieser Upload kann nicht mehr eingereicht werden." });
			if (!slackToken || !slackChannel) return res.status(500).json({ error: "Server nicht konfiguriert (Slack)." });

			const plan = parseJson<Plan>(row.plan);
			// The grant may have been narrowed since the analysis.
			const allowed = session.grant(row.region)!.datasets;
			if (plan.tables.some((t) => !allowed.includes(t.dataset))) {
				return res.status(403).json({ error: "Für einen der Datensätze sind Sie nicht mehr freigeschaltet." });
			}
			const files = parseJson<{ id: string; name: string }[]>(row.files) ?? [];
			const blocks = submissionBlocks({
				submissionId: row.id,
				regionLabel: row.region_label ?? row.region,
				uploadedBy: row.uploaded_by,
				description: row.description ?? "",
				plan,
				fileLinks: files.map((f) => ({ name: f.name, url: `${publicUrl}/admin/files/${f.id}` })),
				reviewUrl: `${publicUrl}/data-upload/review/${row.id}?sig=${reviewSignature(secret, row.id)}`,
			});
			const msg = await slackCall(slackToken, "chat.postMessage", {
				channel: slackChannel,
				text: `Neue Daten für ${row.region_label}: ${plan.summary}`,
				blocks,
				unfurl_links: false,
			});
			// Nothing to write (only unmatched data or no changes) → it just needs a human to look at it.
			const status = hasChanges(plan) ? "pending" : "needs_review";
			await db().where({ id: row.id }).update({ status, slack_channel: msg.channel, slack_ts: msg.ts });
			res.json({ data: { status } });
		});

		router.post("/api/submissions/:id/discard", async (req, res) => {
			const session = await auth(req, res);
			if (!session) return;
			await db().where({ id: req.params.id }).whereIn("region", session.regionIds).whereIn("status", ["draft", "error"]).update({ status: "discarded" });
			res.json({ data: { status: "discarded" } });
		});

		/* ------------------------------ review page ------------------------------ */

		router.get("/review/:id", async (req, res) => {
			if (!verifyReviewSignature(secret, req.params.id, req.query.sig as string | undefined)) return res.status(403).send("Forbidden");
			const row = await db().where({ id: req.params.id }).first();
			if (!row) return res.status(404).send("Not found");
			res.type("html").send(reviewPage({ base: mount, region: row.region_label ?? row.region, row, plan: parseJson<Plan>(row.plan) }));
		});

		/* ------------------------------ slack ------------------------------ */

		router.post("/slack/actions", async (req, res) => {
			if (!slackSigningSecret || !slackToken) return res.status(500).send("not configured");
			// Directus only parses JSON bodies, so Slack's form-encoded body is still unread here.
			const raw = await readRaw(req);
			if (!verifySlackSignature(slackSigningSecret, req.headers, raw)) return res.status(401).send("bad signature");

			const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}");
			const action = payload.actions?.[0];
			res.status(200).send(""); // Slack wants an ack within 3s

			if (!action || !["approve", "reject"].includes(action.action_id)) return;
			const user = payload.user?.id as string;
			const channel = payload.channel?.id as string;
			const ts = payload.message?.ts as string;
			const blocks = (payload.message?.blocks ?? []) as Record<string, unknown>[];

			try {
				// Claim the submission atomically so a double click can't apply it twice.
				const claimed = await db()
					.where({ id: action.value, status: "pending" })
					.update({ status: action.action_id === "approve" ? "applying" : "rejected", decided_by: user, decided_at: new Date() });
				if (!claimed) {
					await slackCall(slackToken, "chat.postEphemeral", { channel, user, text: "Dieser Upload wurde bereits bearbeitet." });
					return;
				}

				const row = await db().where({ id: action.value }).first();

				if (action.action_id === "reject") {
					await slackCall(slackToken, "chat.update", { channel, ts, blocks: resolvedBlocks(blocks, `:x: Abgelehnt von <@${user}>`) });
					await notifyUploader(row, false, undefined, channel, ts);
					return;
				}

				const counts = await applyPlan(ItemsService, await getSchema(), database, parseJson<Plan>(row.plan));
				await db().where({ id: row.id }).update({ status: "applied" });
				await slackCall(slackToken, "chat.update", {
					channel,
					ts,
					blocks: resolvedBlocks(
						blocks,
						`:white_check_mark: Übernommen von <@${user}> – ${counts.created} neu, ${counts.updated} aktualisiert, ${counts.unchanged} unverändert`,
					),
				});
				await notifyUploader(row, true, counts, channel, ts);
			} catch (err: any) {
				logger.error(err, `[data-upload] slack action failed for ${action.value}`);
				await db().where({ id: action.value }).update({ status: "failed", error: String(err?.message ?? err) });
				await slackCall(slackToken, "chat.postMessage", {
					channel,
					thread_ts: ts,
					text: `:rotating_light: Schreiben fehlgeschlagen: ${String(err?.message ?? err)}`,
				}).catch(() => {});
			}
		});

		/* ------------------------------ helpers ------------------------------ */

		/** Tells the uploader about the decision; a failed mail is reported in the Slack thread, never thrown. */
		async function notifyUploader(
			row: Record<string, any>,
			approved: boolean,
			counts: { created: number; updated: number; unchanged: number } | undefined,
			channel: string,
			ts: string,
		) {
			if (!row.uploaded_by) return;
			try {
				const mail = new MailService({ schema: await getSchema(), knex: database, accountability: null });
				await mail.send({
					to: row.uploaded_by,
					subject: approved
						? `Ihre Daten für ${row.region_label ?? "das Klimadashboard"} wurden übernommen`
						: `Ihre Daten für ${row.region_label ?? "das Klimadashboard"} wurden nicht übernommen`,
					html: decisionEmail({
						approved,
						region: row.region_label ?? "",
						createdAt: new Date(row.created_at),
						description: row.description ?? "",
						counts,
						portalUrl: `${publicUrl}/data-upload/`,
					}),
				});
			} catch (err: any) {
				logger.error(err, `[data-upload] decision mail for ${row.id} failed`);
				await slackCall(slackToken!, "chat.postMessage", {
					channel,
					thread_ts: ts,
					text: `:warning: Benachrichtigung an ${row.uploaded_by} konnte nicht verschickt werden: ${String(err?.message ?? err)}`,
				}).catch(() => {});
			}
		}

		async function storeFiles(files: UploadedFile[], regionLabel: string, schema: Awaited<ReturnType<typeof getSchema>>) {
			const svc = new FilesService({ schema, accountability: null });
			const storage = String(env.STORAGE_LOCATIONS ?? "local").split(",")[0]!.trim();
			const refs: { id: string; name: string }[] = [];
			for (const f of files) {
				const id = await svc.uploadOne(Readable.from(f.buffer), {
					storage,
					filename_download: f.filename,
					type: f.mimetype,
					title: `Daten-Upload ${regionLabel}: ${f.filename}`,
					folder: uploadFolder,
				});
				refs.push({ id: String(id), name: f.filename });
			}
			return refs;
		}

		async function notifyError(text: string) {
			if (!slackToken || !slackChannel) return;
			await slackCall(slackToken, "chat.postMessage", { channel: slackChannel, text: `:rotating_light: ${text}` }).catch(() => {});
		}
	},
});

function readRaw(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function readMultipart(req: IncomingMessage): Promise<{ region: string; description: string; files: UploadedFile[] }> {
	return new Promise((resolve, reject) => {
		let bb: Busboy.Busboy;
		try {
			bb = Busboy({ headers: req.headers, limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES } });
		} catch {
			return reject(new UserError("Ungültiger Upload."));
		}
		let region = "";
		let description = "";
		let total = 0;
		const files: UploadedFile[] = [];
		bb.on("field", (name, value) => {
			if (name === "region") region = value.slice(0, 64);
			if (name === "description") description = value.slice(0, 2000);
		});
		bb.on("file", (_name, stream, info) => {
			const chunks: Buffer[] = [];
			stream.on("data", (c: Buffer) => {
				total += c.length;
				// Past the limit: keep draining the request, but stop buffering it.
				if (total > MAX_TOTAL_BYTES) return reject(new UserError("Der Upload ist insgesamt größer als 40 MB."));
				chunks.push(c);
			});
			stream.on("limit", () => reject(new UserError(`${info.filename} ist größer als 20 MB.`)));
			stream.on("end", () =>
				files.push({ filename: info.filename || "upload", mimetype: info.mimeType, buffer: Buffer.concat(chunks) }),
			);
		});
		bb.on("filesLimit", () => reject(new UserError(`Maximal ${MAX_FILES} Dateien pro Upload.`)));
		bb.on("error", reject);
		bb.on("close", () => resolve({ region, description, files }));
		req.pipe(bb);
	});
}
