/**
 * Zero-trust provenance (PRD §2, §18.1): every intent is Ed25519-signed with
 * the repository key generated at `drift init`. Key lives in
 * `.drift/keys/ed25519.pem` (never committed); the public key is stored in
 * the DAG header so signatures can be verified by anyone with the repo.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { randomBytes } from "node:crypto";

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
