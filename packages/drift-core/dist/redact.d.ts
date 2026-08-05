/**
 * Secret redaction (PRD §17.1, §18.2). Always applied before any intent is
 * persisted. Patterns come from the repo's `.drift/config.toml` or the
 * secure defaults below.
 */
export declare const DEFAULT_PATTERN_SOURCES: string[];
export interface RedactResult {
    text: string;
    count: number;
}
export declare function compilePatterns(sources: string[]): RegExp[];
export declare function redact(text: string, patterns?: RegExp[]): RedactResult;
//# sourceMappingURL=redact.d.ts.map