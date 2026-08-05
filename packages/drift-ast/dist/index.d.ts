/**
 * @drift/ast — semantic parsing and AST delta computation.
 *
 * The parser is intentionally dependency-free: it extracts named symbols
 * (functions, classes, methods, arrow-function constants) from source code,
 * producing a stable "semantic signature" for a file. Deltas between two
 * states of a file are computed at symbol granularity, so a rename is a
 * RENAMED mutation rather than delete+add, and a function that moved is
 * MOVED rather than modified.
 *
 * The parser interface (`parseSymbols`) is the plugin point where a full
 * tree-sitter implementation can be dropped in later (ADR-002).
 */
export type MutationType = "ADDED" | "MODIFIED" | "DELETED" | "MOVED" | "RENAMED";
export type SymbolKind = "function" | "method" | "class" | "arrow" | "default";
export interface SymbolInfo {
    /** Unique semantic id for the node, e.g. `src/auth.ts::function::verifyToken`. */
    id: string;
    name: string;
    kind: SymbolKind;
    /** 1-based start line */
    startLine: number;
    /** 1-based inclusive end line */
    endLine: number;
    /** SHA-256 hex of the trimmed source span (used for rename/move detection) */
    bodyHash: string;
}
export interface ASTDelta {
    filePath: string;
    type: MutationType;
    nodeIds: string[];
    summary: string;
}
export interface FileDelta {
    filePath: string;
    pre: SymbolInfo[];
    post: SymbolInfo[];
    changes: ASTDelta[];
}
export type SupportedLanguage = "typescript" | "python";
/** Map a file path to a supported language, or null when unsupported. */
export declare function detectLanguage(filePath: string): SupportedLanguage | null;
/** Rough binary sniff: NUL byte in the first 8 KiB. */
export declare function isBinary(content: Buffer): boolean;
export declare class ParseError extends Error {
    constructor(message: string);
}
/**
 * Parse a source file into named symbols.
 * Throws {@link ParseError} when the source is syntactically broken
 * (e.g. unbalanced braces) so callers can reject the commit (exit code 2).
 */
export declare function parseSymbols(source: string, language: SupportedLanguage): SymbolInfo[];
export declare function parseFile(filePath: string, source: string): {
    symbols: SymbolInfo[];
    language: SupportedLanguage;
};
/**
 * Compute the semantic delta between two states of a file.
 * `pre`/`post` may be `null` when the file did not exist in that state.
 */
export declare function computeDelta(filePath: string, pre: SymbolInfo[] | null, post: SymbolInfo[] | null): FileDelta;
/**
 * Real syntax validation (the reason `drift realize` can promise that broken
 * code never enters history, PRD §9.2).
 *
 * TypeScript/JavaScript: parsed by the TypeScript compiler (transpile only —
 * no typechecking, so type errors never block commits).
 * Python: parsed with `ast` when a python interpreter is available.
 *
 * Returns a human-readable message for the first syntax error, or null when
 * the source is syntactically valid (or cannot be checked in this env).
 */
export declare function validateSyntax(source: string, language: SupportedLanguage): string | null;
/** Text-only delta for unsupported/binary files. */
export declare function textDelta(filePath: string, pre: string | null, post: string | null): FileDelta;
//# sourceMappingURL=index.d.ts.map