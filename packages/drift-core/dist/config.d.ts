/**
 * `.drift/config.toml` handling (PRD §17.1). Ships with a tiny TOML-subset
 * parser so the CLI stays dependency-free. Unknown sections/keys are ignored;
 * missing keys fall back to secure defaults.
 */
import { compilePatterns } from "./redact.js";
export interface DriftConfig {
    core: {
        version: number;
        default_model: string;
    };
    ast: {
        parsers: string[];
        fallback_to_text_on_error: boolean;
    };
    redaction: {
        patterns: string[];
    };
    encryption: {
        enabled: boolean;
        key_provider: string;
    };
    telemetry: {
        enabled: boolean;
    };
}
export declare const DEFAULT_CONFIG: DriftConfig;
export declare const CONFIG_TEMPLATE = "# Drift configuration (PRD \u00A717.1)\n[core]\nversion = 1\ndefault_model = \"claude-3-5-sonnet\"\n\n[ast]\nparsers = [\"typescript\", \"python\"]\nfallback_to_text_on_error = true\n\n[redaction]\npatterns = [\n  \"AKIA[0-9A-Z]{16}\",\n  \"sk-[A-Za-z0-9_-]{20,}\",\n  \"-----BEGIN [A-Z ]*PRIVATE KEY-----\",\n  \"(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\",\n  \"github_pat_[A-Za-z0-9_]{22,}\",\n  \"xox[baprs]-[A-Za-z0-9-]{10,}\",\n  \"AIza[0-9A-Za-z_-]{35}\",\n  \"sk_live_[A-Za-z0-9]{24,}\",\n  \"eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\"\n]\n\n[encryption]\nenabled = false\nkey_provider = \"env:DRIFT_MASTER_KEY\"\n\n[telemetry]\nenabled = false\n";
/** Minimal TOML-subset parser: sections, `key = "value"`, arrays, bools, ints. */
export declare function parseToml(text: string): Record<string, Record<string, unknown>>;
export declare function loadConfig(driftDir: string): DriftConfig;
export { compilePatterns };
//# sourceMappingURL=config.d.ts.map