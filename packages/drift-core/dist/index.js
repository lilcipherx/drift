export { Drift, ensureDriftGitignore } from "./engine.js";
export { PublicStore, buildPublicSummary, genericPublicSummary, sanitizePublicText, signingKeyIdFor, PUBLIC_FILES_MAX, PUBLIC_SUMMARY_MAX, } from "./public.js";
export { DRIFT_INTENT_ID_RE, extractDriftIntentIds, parseGitTrailers } from "./trailers.js";
export { DriftError, EXIT, NotInitializedError } from "./errors.js";
export { ENCRYPTION_MARKER, canonicalJson, decryptAesGcm, deriveMasterKey, encryptAesGcm, generateKeyPair, isEncrypted, newIntentId, sha256Hex, signPayload, verifyPayload, } from "./crypto.js";
export { DEFAULT_CONFIG, loadConfig, parseToml } from "./config.js";
export { IntentStore } from "./store.js";
export { redact, compilePatterns, DEFAULT_PATTERN_SOURCES } from "./redact.js";
export { blameLine, blameLines, commit, commitExists, currentHead, findRepoRoot, gitIdentity, readFileAt, stageAll, stagedNameStatus, } from "./git.js";
//# sourceMappingURL=index.js.map