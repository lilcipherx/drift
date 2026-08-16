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
import { evaluateTrustRootChange } from "@drift/core";
/** Comment marker version 2 — the App owns the app-specific marker and must
 * never edit the Action's comment (and vice versa). Legacy markers are
 * recognized for in-place migration ONLY when ownership is independently
 * verified (a performed_via_github_app.id set by GitHub, never a user). */
export const SUMMARY_MARKER = "<!-- drift:app-summary:v2 -->";
export const ACTION_MARKER = "<!-- drift:action-summary:v2 -->";
export const LEGACY_SUMMARY_MARKERS = ["<!-- drift:pr-summary:v2 -->", "<!-- drift:summary -->"];
export const TRUST_ROOT_WARNING = "## ⚠ Drift trust-root change detected\n\nThis pull request modifies `.drift/public/key.pem`.\n\nNew provenance cannot be trusted automatically until the key rotation is reviewed through the documented rotation process.";
export function evaluateKeyChange(baseKey, headKey) {
    return evaluateTrustRootChange(baseKey, headKey);
}
/**
 * A comment belongs to the APP ONLY when GitHub itself attests that THIS App
 * authored it (`performed_via_github_app.id` set by GitHub, never by the
 * commenter) AND that id equals the CONFIGURED Drift App id. An arbitrary
 * positive id is not ownership — a different GitHub App that happens to use
 * the marker must never be edited (issue 7). When the expected App id is
 * unavailable (empty in production), ownership can not be proven, so no
 * comment is treated as owned (fail-safe: we may post new comments but never
 * PATCH a possibly-foreign comment). Comments authored by the composite
 * Action (`github-actions[bot]` login) belong to the Action and the App must
 * never edit them; user-authored bodies that merely contain a marker are
 * spoofs and are never touched.
 */
export function isDriftOwnedComment(comment, expectedAppId) {
    if (!comment || typeof comment !== "object")
        return false;
    if (typeof comment.body !== "string")
        return false;
    const hasMarker = comment.body.includes(SUMMARY_MARKER) ||
        LEGACY_SUMMARY_MARKERS.some((m) => comment.body.includes(m));
    if (!hasMarker)
        return false;
    // Ownership is only provable when the configured App id is available AND
    // matches the GitHub-attested performed_via_github_app.id.
    if (!expectedAppId || String(expectedAppId).trim().length === 0)
        return false;
    const appId = comment.performed_via_github_app?.id;
    return typeof appId === "number" && Number.isInteger(appId) && appId > 0 && String(appId) === String(expectedAppId).trim();
}
/**
 * Find the canonical owned comment (v2 marker first, legacy for migration) —
 * deterministically the OLDEST owned comment (lowest id), so repeated
 * webhook deliveries always update the same comment. Returns the canonical
 * comment plus the number of additional owned duplicates (for diagnostics).
 */
export function findOwnedDriftComment(comments, expectedAppId) {
    const owned = comments
        .filter((c) => isDriftOwnedComment(c, expectedAppId))
        .sort((a, b) => a.id - b.id); // deterministic: lowest id = oldest
    if (owned.length === 0)
        return null;
    const canonical = owned.find((c) => c.body.includes(SUMMARY_MARKER)) ??
        owned.find((c) => LEGACY_SUMMARY_MARKERS.some((m) => c.body.includes(m))) ??
        owned[0];
    return { id: canonical.id, duplicates: owned.length - 1 };
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
    // Failure key states: replacement, removal and ANY malformed key state
    // (malformed initial key, malformed replacement, malformed base root). Only
    // a cryptographically parseable initial key is a neutral bootstrap.
    const FAILING_KEY_STATES = new Set([
        "replaced",
        "removed",
        "malformed-bootstrap",
        "malformed-replacement",
        "base-malformed",
    ]);
    const blockingKeyChange = FAILING_KEY_STATES.has(keyChange);
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
                : keyChange === "removed"
                    ? "the pull request removes .drift/public/key.pem (trust-root change)"
                    : keyChange === "base-malformed"
                        ? "the base branch trust root (.drift/public/key.pem) is not a valid Drift public key — no trust root can be established"
                        : keyChange === "malformed-bootstrap"
                            ? "the pull request introduces a MALFORMED .drift/public/key.pem — a malformed initial key is not a bootstrap"
                            : "the pull request replaces .drift/public/key.pem with MALFORMED content that is not a valid Drift public key");
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