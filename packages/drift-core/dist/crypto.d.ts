/**
 * Zero-trust provenance (PRD §2, §18.1): every intent is Ed25519-signed with
 * the repository key generated at `drift init`. Key lives in
 * `.drift/keys/ed25519.pem` (never committed); the public key is stored in
 * the DAG header so signatures can be verified by anyone with the repo.
 */
export interface KeyPair {
    privateKeyPem: string;
    publicKeyPem: string;
}
export declare function generateKeyPair(): KeyPair;
/** Deterministic, key-order-stable JSON stringification. */
export declare function canonicalJson(value: unknown): string;
export declare function signPayload(payload: string, privateKeyPem: string): string;
export declare function verifyPayload(payload: string, publicKeyPem: string, signatureBase64: string): boolean;
export declare function sha256Hex(input: string): string;
/** `did_`-prefixed random intent id (128 bits of entropy). */
export declare function newIntentId(): string;
/** Marker prefix for encrypted fields, so legacy plaintext stays readable. */
export declare const ENCRYPTION_MARKER = "encv1:";
/**
 * Derive a 32-byte AES key from `DRIFT_MASTER_KEY`.
 * - a 64-char hex string is used verbatim (32 bytes);
 * - anything else is hashed with SHA-256 (passphrase mode).
 */
export declare function deriveMasterKey(secret: string): Buffer;
/**
 * Encrypt a string with AES-256-GCM. Output format:
 * `encv1:<base64(iv[12] + ciphertext + authTag[16])>`.
 * A fresh random 12-byte IV is generated per call (nonce reuse is impossible).
 *
 * `aad` (additional authenticated data, e.g. the intent id) is authenticated
 * but not stored, so ciphertext cannot be silently moved between intents.
 */
export declare function encryptAesGcm(plaintext: string, key: Buffer, aad?: string): string;
/**
 * Decrypt an `encv1:` payload. Throws on malformed payloads, wrong keys,
 * mismatched AAD, or tampered ciphertext (GCM authentication failure).
 */
export declare function decryptAesGcm(payload: string, key: Buffer, aad?: string): string;
/** True when a stored value is an encrypted payload (vs legacy plaintext). */
export declare function isEncrypted(value: string): boolean;
//# sourceMappingURL=crypto.d.ts.map