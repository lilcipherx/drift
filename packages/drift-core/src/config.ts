/**
 * `.drift/config.toml` handling (PRD §17.1). Ships with a tiny TOML-subset
 * parser so the CLI stays dependency-free. Unknown sections/keys are ignored;
 * missing keys fall back to secure defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compilePatterns } from "./redact.js";

export interface DriftConfig {
  core: { version: number; default_model: string };
  ast: { parsers: string[]; fallback_to_text_on_error: boolean };
  redaction: { patterns: string[] };
  telemetry: { enabled: boolean };
}

export const DEFAULT_CONFIG: DriftConfig = {
  core: { version: 1, default_model: "claude-3-5-sonnet" },
  ast: { parsers: ["typescript", "python"], fallback_to_text_on_error: true },
  redaction: {
    patterns: [
      "AKIA[0-9A-Z]{16}",
      "sk-[A-Za-z0-9_-]{20,}",
      "-----BEGIN [A-Z ]*PRIVATE KEY-----",
      "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}",
      "github_pat_[A-Za-z0-9_]{22,}",
      "xox[baprs]-[A-Za-z0-9-]{10,}",
      "AIza[0-9A-Za-z_-]{35}",
      "sk_live_[A-Za-z0-9]{24,}",
      "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
    ],
  },
  telemetry: { enabled: false },
};

export const CONFIG_TEMPLATE = `# Drift configuration (PRD §17.1)
[core]
version = 1
default_model = "claude-3-5-sonnet"

[ast]
parsers = ["typescript", "python"]
fallback_to_text_on_error = true

[redaction]
patterns = [
  "AKIA[0-9A-Z]{16}",
  "sk-[A-Za-z0-9_-]{20,}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}",
  "github_pat_[A-Za-z0-9_]{22,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}",
  "AIza[0-9A-Za-z_-]{35}",
  "sk_live_[A-Za-z0-9]{24,}",
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"
]

[telemetry]
enabled = false
`;

/** Minimal TOML-subset parser: sections, `key = "value"`, arrays, bools, ints. */
export function parseToml(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      if (!out[section]) out[section] = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let raw = line.slice(eq + 1).trim();
    let value: unknown = raw;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      value = raw
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
        .filter((s) => s.length > 0);
    } else if (raw.startsWith('"') && raw.endsWith('"')) {
      value = raw.slice(1, -1);
    } else if (raw.startsWith("'") && raw.endsWith("'")) {
      value = raw.slice(1, -1);
    } else if (raw === "true") {
      value = true;
    } else if (raw === "false") {
      value = false;
    } else if (/^-?\d+$/.test(raw)) {
      value = Number(raw);
    }
    (out[section] ??= {})[key] = value;
  }
  return out;
}

export function loadConfig(driftDir: string): DriftConfig {
  const configPath = join(driftDir, "config.toml");
  if (!existsSync(configPath)) return DEFAULT_CONFIG;
  try {
    const parsed = parseToml(readFileSync(configPath, "utf8"));
    const config: DriftConfig = structuredClone(DEFAULT_CONFIG);
    const core = parsed["core"];
    if (core) {
      if (typeof core.version === "number") config.core.version = core.version;
      if (typeof core.default_model === "string")
        config.core.default_model = core.default_model;
    }
    const ast = parsed["ast"];
    if (ast) {
      if (Array.isArray(ast.parsers)) config.ast.parsers = ast.parsers as string[];
      if (typeof ast.fallback_to_text_on_error === "boolean")
        config.ast.fallback_to_text_on_error = ast.fallback_to_text_on_error;
    }
    const red = parsed["redaction"];
    if (red && Array.isArray(red.patterns)) {
      config.redaction.patterns = red.patterns as string[];
    }
    const tel = parsed["telemetry"];
    if (tel && typeof tel.enabled === "boolean")
      config.telemetry.enabled = tel.enabled;
    return config;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export { compilePatterns };
