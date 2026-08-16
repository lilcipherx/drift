/**
 * Build the semantic PR summary comment from SAFE public intent views
 * (ADR-009). Never receives or renders `prompt` — the full prompt is private
 * and must never appear in a PR comment or check-run summary.
 */
import type { IntentView } from "./intents.js";
import { SUMMARY_MARKER, type ProvenanceAudit } from "./trust.js";
export { SUMMARY_MARKER };
export interface SummaryInput {
    owner: string;
    repo: string;
    prNumber: number;
    prTitle: string;
    intents: IntentView[];
    repoUrl?: string;
    /** Trust-root warning is prepended when the PR modifies key.pem. */
    keyChange?: "replaced" | "removed";
    /** Public-provenance integrity violations (append-only rules). */
    audit?: ProvenanceAudit;
}
export declare function summarizeIntents(input: SummaryInput): string;
//# sourceMappingURL=summarize.d.ts.map