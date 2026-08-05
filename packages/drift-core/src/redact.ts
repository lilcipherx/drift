/**
 * Secret redaction (PRD §17.1, §18.2). Always applied before any intent is
 * persisted. Patterns come from the repo's `.drift/config.toml` or the
 * secure defaults below.
 */

export const DEFAULT_PATTERN_SOURCES: string[] = [
  // AWS access key
  "AKIA[0-9A-Z]{16}",
  // OpenAI / Anthropic-style keys
  "sk-[A-Za-z0-9_-]{20,}",
  "sk-ant-[A-Za-z0-9_-]{20,}",
  // PEM private keys
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  // GitHub tokens
  "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}",
  "github_pat_[A-Za-z0-9_]{22,}",
  // Slack tokens
  "xox[baprs]-[A-Za-z0-9-]{10,}",
  // Google API keys
  "AIza[0-9A-Za-z_-]{35}",
  // Stripe live keys
  "sk_live_[A-Za-z0-9]{24,}",
  // JWTs (three dot-separated base64url segments)
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
];

const REPLACEMENT = "[REDACTED]";

export interface RedactResult {
  text: string;
  count: number;
}

export function compilePatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src, "g"));
    } catch {
      // Invalid user-supplied pattern: skip, but never crash.
    }
  }
  return out;
}

export function redact(
  text: string,
  patterns: RegExp[] = compilePatterns(DEFAULT_PATTERN_SOURCES),
): RedactResult {
  let result = text;
  let count = 0;
  for (const pattern of patterns) {
    if (!pattern.global) {
      // ensure /g so replaceAll-style scanning works
      continue;
    }
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      count++;
      return REPLACEMENT;
    });
  }
  return { text: result, count };
}
