/**
 * Read `Drift-Intent: <id>` trailers from pull request commits and hydrate the
 * intent objects from `.drift/objects/` at the PR head (PRD §16.2).
 */
import { deriveMasterKey, decryptAesGcm, isEncrypted } from "@drift/core";
const TRAILER_RE = /Drift-Intent:\s*(did_[0-9a-f]{32})/g;
/** Extract unique intent ids referenced by a set of commits (order preserved). */
export function extractIntentIds(commits) {
    const ids = [];
    const seen = new Set();
    for (const commit of commits) {
        TRAILER_RE.lastIndex = 0;
        let m;
        while ((m = TRAILER_RE.exec(commit.message)) !== null) {
            const id = m[1];
            if (!seen.has(id)) {
                seen.add(id);
                ids.push(id);
            }
        }
    }
    return ids;
}
/**
 * Decrypt an `encv1:` prompt when DRIFT_MASTER_KEY is available. `aad` must
 * match the intent id the payload was bound to at realize time.
 */
export function decryptPrompt(prompt, masterKeyEnv, aad) {
    if (!isEncrypted(prompt))
        return { prompt, encrypted: false };
    if (!masterKeyEnv)
        return { prompt: "🔒 [encrypted]", encrypted: true };
    try {
        return { prompt: decryptAesGcm(prompt, deriveMasterKey(masterKeyEnv), aad), encrypted: true };
    }
    catch {
        return { prompt: "🔒 [encrypted: invalid key]", encrypted: true };
    }
}
/**
 * Load the intent objects referenced by a PR. Falls back to the commit
 * message subject as the prompt when the object is missing (e.g. `.drift`
 * not committed).
 */
export async function fetchIntents(github, owner, repo, ref, commits, ids, masterKeyEnv) {
    if (ids.length === 0)
        return [];
    // Fetch `.drift/objects/**` until every referenced intent is found (the
    // object path is content-addressed, so it cannot be derived from the id).
    const loaded = new Map();
    const paths = await github.getObjectPaths(owner, repo, ref);
    for (const path of paths) {
        const raw = await github.getFileContent(owner, repo, path, ref);
        if (!raw)
            continue;
        let obj;
        try {
            obj = JSON.parse(raw);
        }
        catch {
            continue;
        }
        if (obj.id && ids.includes(obj.id))
            loaded.set(obj.id, obj);
        // All referenced intents found — stop issuing more content API calls.
        if (loaded.size >= ids.length)
            break;
    }
    // subject fallback: map each intent id to the commit that introduced it
    const subjectByIntent = new Map();
    for (const commit of commits) {
        TRAILER_RE.lastIndex = 0;
        let m;
        while ((m = TRAILER_RE.exec(commit.message)) !== null) {
            if (!subjectByIntent.has(m[1])) {
                subjectByIntent.set(m[1], commit.message.split("\n")[0] ?? "");
            }
        }
    }
    const views = [];
    for (const id of ids) {
        const obj = loaded.get(id);
        const rawPrompt = obj?.prompt ?? subjectByIntent.get(id) ?? "";
        const decrypted = decryptPrompt(rawPrompt, masterKeyEnv, id);
        views.push({
            id,
            authorType: obj?.author?.type ?? "unknown",
            authorId: obj?.author?.identifier ?? "unknown",
            model: obj?.author?.model ?? null,
            prompt: decrypted.prompt,
            encryptedPrompt: decrypted.encrypted,
            verifyCmd: obj?.verifyCmd ?? null,
            files: (obj?.astDelta ?? []).map((d) => ({
                path: d.filePath ?? "?",
                mutationType: d.type ?? "MODIFIED",
                summary: d.summary ?? null,
            })),
            signature: Boolean(obj?.signature),
        });
    }
    return views;
}
//# sourceMappingURL=intents.js.map