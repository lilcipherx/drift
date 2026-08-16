/**
 * Shared trust policy for the Drift GitHub App (issues A, B, C, D):
 *
 *  - `evaluateKeyChange` — detect base/head trust-root differences BEFORE any
 *    \"no intents\" early return, so a key-only PR is never invisible.
 *  - `isDriftOwnedComment` — a marker string alone is NOT proof of ownership;
 *    only GitHub-attested authors (github-actions[bot] login, or a real
 *    `performed_via_github_app.id`) are ever updated.
 *  - `deriveProvenanceConclusion` — the ONE policy that maps provenance state
 *    to a Check Run conclusion. The App never reports unconditional success:
 *    invalid/untrusted/malformed/key-change provenance fails the check.
 */
/** Comment marker version 2 — the App owns the app-specific marker and must
 * never edit the Action's comment (and vice versa). Legacy markers are
 * recognized for in-place migration ONLY when ownership is independently
 * verified (a performed_via_github_app.id set by GitHub, never a user). */
export const SUMMARY_MARKER = "<!-- drift:app-summary:v2 -->";
export const ACTION_MARKER = "<!-- drift:action-summary:v2 -->";
export const LEGACY_SUMMARY_MARKERS = ["<!-- drift:pr-summary:v2 -->", "<!-- drift:summary -->"];
export const TRUST_ROOT_WARNING = "## ⚠ Drift trust-root change detected\n\nThis pull request modifies `.drift/public/key.pem`.\n\nNew provenance cannot be trusted automatically until the key rotation is reviewed through the documented rotation process.";
export function evaluateKeyChange(baseKey, headKey) {
    if (!baseKey && !headKey)
        return "none";
    if (!baseKey && headKey)
        return "bootstrap";
    if (baseKey && !headKey)
        return "removed";
    if (baseKey && headKey) {
        return baseKey.trim() === headKey.trim() ? "unchanged" : "replaced";
    }
    return "none";
}
/**
 * A comment belongs to the APP ONLY when GitHub itself attests that the App
 * authored it (`performed_via_github_app.id` is set by GitHub, not by the
 * commenter — a user cannot forge it). Comments authored by the composite
 * Action (`github-actions[bot]` login) belong to the Action and the App must
 * never edit them; user-authored bodies that merely contain a marker are
 * spoofs and are never touched.
 */
export function isDriftOwnedComment(comment) {
    if (!comment || typeof comment !== "object")
        return false;
    if (typeof comment.body !== "string")
        return false;
    const hasMarker = comment.body.includes(SUMMARY_MARKER) ||
        LEGACY_SUMMARY_MARKERS.some((m) => comment.body.includes(m));
    if (!hasMarker)
        return false;
    const appId = comment.performed_via_github_app?.id;
    return typeof appId === "number" && Number.isInteger(appId) && appId > 0;
}
/** Find the canonical owned comment (v2 marker first, legacy for migration). */
export function findOwnedDriftComment(comments) {
    const owned = comments.filter(isDriftOwnedComment);
    return (owned.find((c) => c.body.includes(SUMMARY_MARKER)) ??
        owned.find((c) => LEGACY_SUMMARY_MARKERS.some((m) => c.body.includes(m))) ??
        null);
}
/** Signature states that force a failing check run. */
const FAILING_STATES = new Set(["invalid", "untrusted-key", "malformed"]);
export const NO_AUDIT = { violations: [], replayIds: [], ambiguousIds: [] };
/**
 * The default policy — the App never reports unconditional success:
 *
 *   success: every referenced manifest is valid against the trusted base key,
 *            no trust-root modification, and no public-provenance integrity
 *            violation (modified/deleted/renamed/orphan manifest, replayed
 *            intent, ambiguous commit association).
 *   failure: any invalid signature, any untrusted-key state, any malformed
 *            manifest, a trust-root replacement/removal (incl. key-only PRs),
 *            or ANY public-provenance integrity violation.
 *   neutral: initial verified bootstrap, unsigned/unverifiable provenance,
 *            missing manifests, mixed valid+neutral sets, or no Drift intents
 *            and no key modification.
 */
export function deriveProvenanceConclusion(input) {
    const { intents, keyChange } = input;
    const audit = input.audit ?? NO_AUDIT;
    const failing = intents.filter((i) => FAILING_STATES.has(i.signatureState));
    const validCount = intents.filter((i) => i.signatureState === "valid").length;
    const blockingKeyChange = keyChange === "replaced" || keyChange === "removed";
    const integrityBroken = audit.violations.length > 0 || audit.replayIds.length > 0 || audit.ambiguousIds.length > 0;
    const count = (state) => intents.filter((i) => i.signatureState === state).length;
    const parts = [
        `Valid intents: ${validCount}`,
        `Invalid: ${count("invalid")}`,
        `Untrusted key: ${count("untrusted-key")}`,
        `Malformed manifests: ${count("malformed")}`,
        `Unsigned: ${count("unsigned")}`,
        `Unverifiable: ${count("unverifiable")}`,
        `Bootstrap: ${count("bootstrap")}`,
        `Missing manifests: ${count("missing")}`,
        `Trust-root change: ${keyChange}`,
        `Provenance violations: ${audit.violations.length + audit.replayIds.length + audit.ambiguousIds.length}`,
    ];
    const summary = parts.join(" · ");
    if (failing.length > 0 || blockingKeyChange || integrityBroken) {
        const reasons = [];
        if (blockingKeyChange) {
            reasons.push(keyChange === "replaced"
                ? "the pull request replaces .drift/public/key.pem (trust-root change)"
                : "the pull request removes .drift/public/key.pem (trust-root change)");
        }
        for (const i of failing) {
            reasons.push(`${i.signatureState === "malformed" ? "malformed manifest" : `${i.signatureState} signature`} for ${i.id ?? "an intent"}`);
        }
        for (const v of audit.violations) {
            reasons.push(`${v.code} manifest ${v.id} (${v.detail})`);
        }
        for (const id of audit.replayIds) {
            reasons.push(`replayed intent ${id} — its manifest already exists on the base branch`);
        }
        for (const id of audit.ambiguousIds) {
            reasons.push(`ambiguous intent ${id} — referenced by more than one commit`);
        }
        return {
            conclusion: "failure",
            title: `${failing.length > 0 ? `${failing.length} intent(s) with untrusted provenance` : blockingKeyChange ? "Drift trust-root change" : "Public provenance integrity violation"}${integrityBroken ? " + provenance integrity" : ""}`,
            summary: `${summary}\n\nReason: ${reasons.join("; ")}.`,
        };
    }
    if (intents.length > 0 && validCount === intents.length) {
        return {
            conclusion: "success",
            title: `${intents.length} intent${intents.length === 1 ? "" : "s"} verified`,
            summary,
        };
    }
    if (intents.length > 0) {
        return {
            conclusion: "neutral",
            title: `${intents.length} intent${intents.length === 1 ? "" : "s"} — unverified or unsigned provenance`,
            summary,
        };
    }
    if (keyChange === "bootstrap") {
        return {
            conclusion: "neutral",
            title: "Drift initial trust-root bootstrap",
            summary: `${summary}\n\nThis PR introduces the first Drift public signing key. Provenance on this PR is classified as an unverified bootstrap — no cryptographic trust-root verification is claimed.`,
        };
    }
    return {
        conclusion: "neutral",
        title: "No Drift provenance on this PR",
        summary,
    };
}
//# sourceMappingURL=trust.js.map