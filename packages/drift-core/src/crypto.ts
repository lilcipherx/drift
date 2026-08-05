/**
 * Zero-trust provenance (PRD §2, §18.1): every intent is Ed25519-signed with
 * the repository key generated at `drift init`. Key lives in
 * `.drift/keys/ed25519.pem` (never committed); the public key is stored in
 * the DAG header so signatures can be verified by anyone with the repo.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";

export interface KeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Deterministic, key-order-stable JSON stringification. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function signPayload(payload: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return nodeSign(null, Buffer.from(payload, "utf8"), key).toString("base64");
}

export function verifyPayload(
  payload: string,
  publicKeyPem: string,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return nodeVerify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** `did_`-prefixed random intent id (128 bits of entropy). */
export function newIntentId(): string {
  return `did_${randomBytes(16).toString("hex")}`;
}

// --------------------------------------------------------------------------
// AES-256-GCM encryption at rest (PRD §7.4, §17.1, §17.2 — v0.2.0)
// --------------------------------------------------------------------------

/** Marker prefix for encrypted fields, so legacy plaintext stays readable. */
export const ENCRYPTION_MARKER = "encv1:";

/**
 * Derive a 32-byte AES key from `DRIFT_MASTER_KEY`.
 * - a 64-char hex string is used verbatim (32 bytes);
 * - anything else is hashed with SHA-256 (passphrase mode).
 */
export function deriveMasterKey(secret: string): Buffer {
  const trimmed = secret.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Encrypt a string with AES-256-GCM. Output format:
 * `encv1:<base64(iv[12] + ciphertext + authTag[16])>`.
 * A fresh random 12-byte IV is generated per call (nonce reuse is impossible).
 *
 * `aad` (additional authenticated data, e.g. the intent id) is authenticated
 * but not stored, so ciphertext cannot be silently moved between intents.
 */
export function encryptAesGcm(plaintext: string, key: Buffer, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return ENCRYPTION_MARKER + Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/**
 * Decrypt an `encv1:` payload. Throws on malformed payloads, wrong keys,
 * mismatched AAD, or tampered ciphertext (GCM authentication failure).
 */
export function decryptAesGcm(payload: string, key: Buffer, aad?: string): string {
  if (!payload.startsWith(ENCRYPTION_MARKER)) {
    throw new Error("not an encrypted payload (missing encv1: marker)");
  }
  const raw = Buffer.from(payload.slice(ENCRYPTION_MARKER.length), "base64");
  if (raw.length < 12 + 16) {
    throw new Error("malformed encrypted payload");
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** True when a stored value is an encrypted payload (vs legacy plaintext). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTION_MARKER);
}
