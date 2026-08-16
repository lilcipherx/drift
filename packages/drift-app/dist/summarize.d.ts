/**
 * Build the semantic PR summary comment from SAFE public intent views
 * (ADR-009). Never receives or renders `prompt` — the full prompt is private
 * and must never appear in a PR comment or check-run summary.
 */
import type { IntentView } from "./intents.js";
/**
 * Invisible marker embedded in every Drift summary comment. The webhook
 * handler uses it to find an existing comment and update it in place, so
 * comments never accumulate across `synchronize` deliveries.
 */
export declare const SUMMARY_MARKER = "<!-- drift:summary -->";
export interface SummaryInput {
    owner: string;
    repo: string;
    prNumber: number;
    prTitle: string;
    intents: IntentView[];
    repoUrl?: string;
}
export declare function summarizeIntents(input: SummaryInput): string;
//# sourceMappingURL=summarize.d.ts.map