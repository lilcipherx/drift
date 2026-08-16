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

const TOKEN_RE = /^([A-Za-z0-9-]+):[ \t]*(.*)$/;

/** Split a commit message into paragraphs (blank-line separated). */
function paragraphs(message: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const line of String(message ?? "").split(/\r?\n/)) {
    if (line.trim() === "") {
      if (cur.length > 0) {
        out.push(cur);
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Parse the trailer block of a commit message (git-trailer semantics).
 * Returns only the tokens found in the final paragraph, in order.
 */
export function parseGitTrailers(message: string): GitTrailer[] {
  const all = paragraphs(message);
  const last = all[all.length - 1];
  if (!last) return [];
  const out: GitTrailer[] = [];
  let i = 0;
  while (i < last.length) {
    const m = TOKEN_RE.exec(last[i]!);
    if (!m) break; // the trailer block ends at the first non-trailer line
    const token = m[1]!;
    let value = m[2]!;
    i++;
    // indented continuation lines extend the current trailer value
    while (i < last.length && /^[ \t]+/.test(last[i]!)) {
      value += ` ${last[i]!.trim()}`;
      i++;
    }
    out.push({ token, value });
  }
  return out;
}

/** Valid Drift intent id: `did_` + 128 bits of hex entropy. */
export const DRIFT_INTENT_ID_RE = /^did_[0-9a-f]{32}$/;

/**
 * All valid `Drift-Intent:` ids referenced by a commit message, deduplicated
 * while preserving order. Invalid ids are ignored (never surfaced).
 */
export function extractDriftIntentIds(message: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const trailer of parseGitTrailers(message)) {
    if (trailer.token !== "Drift-Intent") continue;
    const id = trailer.value.trim();
    if (DRIFT_INTENT_ID_RE.test(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
