/**
 * Build the semantic PR summary comment from intents (PRD §16.2, §26.3):
 * "Review intent, not 2,000 lines of diff."
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