/** Re-exported from @rewire/core (the one implementation, I9); import it from there. */
export { redact, SECRET } from "@rewire/core";
export { buildDiffSummary, type DiffSummary, PATCH_CAP, parseDiff } from "./diff.js";
export {
  type Dropped,
  type FilterOptions,
  filterEvidence,
  MAX_FILE_BYTES,
  MIN_EVIDENCE_CHARS,
} from "./evidence.js";
export {
  type ReviewerDef,
  type ReviewerInput,
  type ReviewResult,
  runReviewer,
} from "./framework.js";
export {
  type PanelResult,
  REVIEWERS,
  runPanel,
  SILENT_FAILURE_PATTERN,
  selectReviewers,
} from "./routing.js";
export { FENCE_TAGS, wrapUntrusted } from "./untrusted.js";
export { blockingFindings, type VerifyContext, verifyFindings } from "./verifier.js";
