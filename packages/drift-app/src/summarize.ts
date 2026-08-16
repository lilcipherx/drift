/**
 * Build the semantic PR summary comment from SAFE public intent views
 * (ADR-009). Never receives or renders `prompt` — the full prompt is private
 * and must never appear in a PR comment or check-run summary.
 */

import { sanitizePublicText } from "@drift/core";
import type { IntentView } from "./intents.js";
import { SUMMARY_MARKER, TRUST_ROOT_WARNING, type ProvenanceAudit } from "./trust.js";

export { SUMMARY_MARKER };


export interface SummaryInput {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  intents: IntentView[];
  repoUrl?: string;
  /** Trust-root warning is prepended when the PR modifies key.pem. A malformed
   *  key state (malformed bootstrap / malformed replacement / malformed base
   *  root) renders its own blocking warning — never a neutral bootstrap. */
  keyChange?: "replaced" | "removed" | "malformed-bootstrap" | "malformed-replacement" | "base-malformed";
  /** Public-provenance integrity violations (append-only rules). */
  audit?: ProvenanceAudit;
}

/** Hard caps so a pathological PR can never produce a huge comment. */
const MAX_INTENTS = 10;
const MAX_FILES = 10;
const SUMMARY_LIMIT = 500;
const META_LIMIT = 120;

/** Sanitize + clamp a value for public rendering. */
function safe(text: string | null | undefined, limit: number): string {
  const cleaned = sanitizePublicText(String(text ?? "")).replace(/`/g, "");
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

/** Human label for a manifest signature/trust state (never the raw prompt). */
const SIGNATURE_LABELS: Record<string, string> = {
  valid: "✓ signed (trusted repository key)",
  invalid: "⚠ invalid signature",
  unsigned: "no signature",
  unverifiable: "⚠ unverifiable (no verification key)",
  "untrusted-key": "⚠ unverified — signed with a different key than the base branch",
  bootstrap: "unverified bootstrap (base branch has no Drift key yet)",
  malformed: "⚠ malformed public manifest — not verified",
  missing: "⚠ public provenance manifest missing",
};

export function summarizeIntents(input: SummaryInput): string {
  const intents = input.intents.slice(0, MAX_INTENTS);
  const truncated = input.intents.length > MAX_INTENTS;
  const lines: string[] = [];

  lines.push(SUMMARY_MARKER);
  if (input.keyChange === "replaced" || input.keyChange === "removed") {
    lines.push(TRUST_ROOT_WARNING);
    lines.push("");
    lines.push("---");
    lines.push("");
  } else if (input.keyChange === "malformed-bootstrap") {
    lines.push("## ⚠ Drift initial trust root is malformed\n\nThis pull request introduces `.drift/public/key.pem`, but the file is not a valid Drift public key. A malformed initial key is NOT a bootstrap — provenance on this PR is blocked until a valid key is introduced.");
    lines.push("");
    lines.push("---");
    lines.push("");
  } else if (input.keyChange === "malformed-replacement") {
    lines.push("## ⚠ Drift trust-root replacement is malformed\n\nThis pull request replaces `.drift/public/key.pem` with content that is not a valid Drift public key. The malformed replacement cannot be trusted — blocked until a valid key is introduced through the rotation process.");
    lines.push("");
    lines.push("---");
    lines.push("");
  } else if (input.keyChange === "base-malformed") {
    lines.push("## ⚠ Drift trust root is malformed on the base branch\n\n`.drift/public/key.pem` on the base branch is not a valid Drift public key — no trust root can be established, so this PR's provenance is unverifiable and blocked.");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  const audit = input.audit;
  const integrityBroken =
    audit &&
    (audit.violations.length > 0 || audit.replayIds.length > 0 || audit.ambiguousIds.length > 0);
  lines.push("## Drift — Why this changed");
  lines.push("");
  lines.push(`${intents.length} intent${intents.length === 1 ? "" : "s"} on this PR · ${input.prTitle ? safe(input.prTitle, 80) : ""}`);

  for (const intent of intents) {
    lines.push("");
    lines.push(`### Intent \`${safe(intent.id, 12)}\``);
    lines.push("");
    if (intent.missingManifest) {
      lines.push("_(public provenance manifest missing — summary is a generic fallback)_");
    } else if (intent.malformedManifest) {
      lines.push(safe(intent.summary, SUMMARY_LIMIT) || "_(no public summary recorded)_");
      lines.push("");
      lines.push(`_⚠ malformed public manifest — not verified${intent.manifestError ? ` (${safe(intent.manifestError, META_LIMIT)})` : ""}_`);
    } else {
      lines.push(safe(intent.summary, SUMMARY_LIMIT) || "_(no public summary recorded)_");
    }
    const trust = SIGNATURE_LABELS[intent.signatureState];
    if (trust && !intent.malformedManifest) {
      lines.push("");
      lines.push(`_${trust}_`);
    }

    const meta: string[] = [];
    if (intent.authorId) meta.push(safe(intent.authorId, META_LIMIT));
    if (intent.authorType && intent.authorType !== "unknown") meta.push(`(${safe(intent.authorType, 16)})`);
    if (intent.model) meta.push(`model ${safe(intent.model, META_LIMIT)}`);
    if (meta.length > 0) {
      lines.push("");
      lines.push("### Generated with");
      lines.push("");
      lines.push(meta.join(" · "));
    }

    if (intent.files.length > 0) {
      lines.push("");
      lines.push("### Affected code");
      lines.push("");
      for (const f of intent.files.slice(0, MAX_FILES)) {
        const detail = f.summary ? ` — ${safe(f.summary, 90)}` : "";
        lines.push(`- \`${safe(f.path, 200)}\` (**${safe(f.mutationType, 16)}**)${detail}`);
      }
      if (intent.files.length > MAX_FILES) lines.push(`- … +${intent.files.length - MAX_FILES} more`);
    }

    if (intent.verifyCmd) {
      lines.push("");
      lines.push("### Verification");
      lines.push("");
      lines.push(`- \`${safe(intent.verifyCmd, META_LIMIT)}\``);
    }

    lines.push("");
    lines.push("### Trace");
    lines.push("");
    lines.push(`- Intent: ${safe(intent.id, 40)}`);
  }

  if (truncated) {
    lines.push("");
    lines.push(`_… and ${input.intents.length - MAX_INTENTS} more intent(s) not shown._`);
  }

  if (integrityBroken && audit) {
    lines.push("");
    lines.push("## ⚠ Public provenance integrity violations");
    lines.push("");
    for (const v of audit.violations) {
      lines.push(`- **${safe(v.code, 32)}** \`${safe(v.id, 40)}\` — ${safe(v.detail, 200)}`);
    }
    for (const id of audit.replayIds) {
      lines.push(`- **replayed** \`${safe(id, 40)}\` — this intent's manifest already exists on the base branch`);
    }
    for (const id of audit.ambiguousIds) {
      lines.push(`- **ambiguous** \`${safe(id, 40)}\` — the intent id is referenced by more than one commit on this PR`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("_Generated by [Drift](https://github.com/lilcipherx/drift) — Git tracks what changed. Drift tracks why._");
  return lines.join("\n");
}
