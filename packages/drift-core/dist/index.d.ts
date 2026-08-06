export { Drift } from "./engine.js";
export type { BlameResult, DoctorCheck, DoctorResult, InitResult, RealizeOptions, RealizeResult, ReplayResult, VerifyResult, } from "./engine.js";
export { DriftError, EXIT, NotInitializedError } from "./errors.js";
export type { ExitCode } from "./errors.js";
export { ENCRYPTION_MARKER, canonicalJson, decryptAesGcm, deriveMasterKey, encryptAesGcm, generateKeyPair, isEncrypted, newIntentId, sha256Hex, signPayload, verifyPayload, } from "./crypto.js";
export { DEFAULT_CONFIG, loadConfig, parseToml } from "./config.js";
export type { DriftConfig } from "./config.js";
export { IntentStore } from "./store.js";
export type { IntentRecord, LogEntry, LogFilters } from "./store.js";
export { redact, compilePatterns, DEFAULT_PATTERN_SOURCES } from "./redact.js";
export { blameLine, blameLines, commit, commitExists, currentHead, findRepoRoot, gitIdentity, readFileAt, stageAll, stagedNameStatus, } from "./git.js";
//# sourceMappingURL=index.d.ts.map