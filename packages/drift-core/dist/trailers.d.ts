/**
 * Git-trailer-aligned parsing for `Drift-Intent:` trailers.
 *
 * Git trailers live in the LAST paragraph of a commit message, one
 * `Token: value` per line, with indented continuation lines belonging to the
 * preceding trailer. This parser mirrors those rules for the trailer tokens
 * Drift generates (`Drift-Intent`, `Model`, `Verification`, `Intent`) instead
 * of doing a fragile substring search across the whole message.
 */
export interface GitTrailer {
    token: string;
    value: string;
}
/**
 * Parse the trailer block of a commit message (git-trailer semantics).
 * Returns only the tokens found in the final paragraph, in order.
 */
export declare function parseGitTrailers(message: string): GitTrailer[];
/** Valid Drift intent id: `did_` + 128 bits of hex entropy. */
export declare const DRIFT_INTENT_ID_RE: RegExp;
/**
 * All valid `Drift-Intent:` ids referenced by a commit message, deduplicated
 * while preserving order. Invalid ids are ignored (never surfaced).
 */
export declare function extractDriftIntentIds(message: string): string[];
//# sourceMappingURL=trailers.d.ts.map