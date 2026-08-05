/**
 * GitHub App JSON Web Token (PRD §16.4). Signed RS256 with the app's private
 * key; used to exchange for a short-lived installation access token.
 */
import { sign } from "node:crypto";
function b64url(input) {
    return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/**
 * Create a GitHub App JWT (max 10 minutes TTL per GitHub docs).
 * Returns a compact JWT string: `header.payload.signature`.
 */
export function createAppJwt(appId, privateKeyPem, ttlSeconds = 600) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
        iat: now,
        exp: now + Math.min(Math.max(ttlSeconds, 1), 600),
        iss: String(appId),
    };
    const headerB64 = b64url(Buffer.from(JSON.stringify(header), "utf8"));
    const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = sign("sha256", Buffer.from(signingInput, "utf8"), privateKeyPem);
    return `${signingInput}.${b64url(signature)}`;
}
/** Decode (without verifying) a JWT for debugging/tests. */
export function decodeJwt(token) {
    const [headerB64, payloadB64] = token.split(".");
    if (!headerB64 || !payloadB64)
        throw new Error("malformed JWT");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return { header, payload };
}
//# sourceMappingURL=jwt.js.map