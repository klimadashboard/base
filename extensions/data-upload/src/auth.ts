import crypto from "node:crypto";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAGIC_LINK_TTL_MS = 20 * 60 * 1000;

function hmac(secret: string, data: string) {
	return crypto.createHmac("sha256", `data-upload:${secret}`).update(data).digest("base64url");
}

function safeEqual(a: string, b: string) {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Random single-use token for a magic link; only its hash is stored. */
export function newMagicToken() {
	const token = crypto.randomBytes(32).toString("base64url");
	return { token, hash: hashToken(token) };
}

export function hashToken(token: string) {
	return crypto.createHash("sha256").update(token).digest("hex");
}

export function normaliseEmail(email: string) {
	return email.trim().toLowerCase();
}

export function issueSession(secret: string, email: string) {
	const payload = Buffer.from(JSON.stringify({ e: email, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
	return `${payload}.${hmac(secret, payload)}`;
}

/** Returns the session's email address, or null. */
export function verifySession(secret: string, token: string | undefined): string | null {
	if (!token) return null;
	const [payload, sig] = token.split(".");
	if (!payload || !sig || !safeEqual(sig, hmac(secret, payload))) return null;
	try {
		const { e, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
		return typeof e === "string" && exp > Date.now() ? e : null;
	} catch {
		return null;
	}
}

export function reviewSignature(secret: string, id: string) {
	return hmac(secret, `review:${id}`);
}

export function verifyReviewSignature(secret: string, id: string, sig: string | undefined) {
	return !!sig && safeEqual(sig, reviewSignature(secret, id));
}
