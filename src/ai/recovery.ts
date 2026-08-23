import type { CustomerPolicy, RecoveryAction } from "../domain.js";
import type { FailureDiagnosis, PolicyDecision, RankedRecovery } from "../browser/types.js";

const RECOVERY_MAP: Record<string, RecoveryAction[]> = {
  OCCLUDED_TARGET: ["CLOSE_MODAL", "SCROLL", "REFRESH"],
  UNEXPECTED_MODAL: ["CLOSE_MODAL", "RETURN_PREVIOUS_STEP", "REFRESH"],
  ELEMENT_MOVED: ["USE_ALTERNATIVE_TARGET", "SCROLL", "CHANGE_VIEWPORT"],
  ELEMENT_RENAMED: ["USE_ALTERNATIVE_TARGET", "REFRESH", "ESCALATE_TO_HUMAN"],
  ICON_ONLY_TARGET: ["USE_ALTERNATIVE_TARGET", "CHANGE_VIEWPORT", "ESCALATE_TO_HUMAN"],
  HIDDEN_ELEMENT: ["USE_ALTERNATIVE_TARGET", "REFRESH", "ESCALATE_TO_HUMAN"],
  OFFSCREEN_TARGET: ["SCROLL", "CHANGE_VIEWPORT", "USE_ALTERNATIVE_TARGET"],
  RESPONSIVE_LAYOUT_CHANGE: ["CHANGE_VIEWPORT", "USE_ALTERNATIVE_TARGET", "SCROLL"],
  AUTH_EXPIRED: ["REAUTHENTICATE", "REFRESH", "ESCALATE_TO_HUMAN"],
  PERMISSION_DENIED: ["ESCALATE_TO_HUMAN", "ABORT", "RETURN_PREVIOUS_STEP"],
  FORM_VALIDATION_ERROR: ["FILL_REQUIRED_FIELD", "RETRY", "ESCALATE_TO_HUMAN"],
  DISABLED_ACTION: ["ESCALATE_TO_HUMAN", "REFRESH", "ABORT"],
  LOADING_STUCK: ["REFRESH", "WAIT", "RETURN_PREVIOUS_STEP"],
  NAVIGATION_ERROR: ["RETURN_PREVIOUS_STEP", "REFRESH", "ABORT"],
  STALE_STATE: ["REFRESH", "RETURN_PREVIOUS_STEP", "ESCALATE_TO_HUMAN"],
  CONFIRMATION_REQUIRED: ["CONFIRM", "ESCALATE_TO_HUMAN", "ABORT"],
  UNKNOWN_STATE: ["ESCALATE_TO_HUMAN", "REFRESH", "RETURN_PREVIOUS_STEP"]
};

export function rankRecoveries(diagnosis: FailureDiagnosis): RankedRecovery[] {
  const actions = RECOVERY_MAP[diagnosis.failureType] ?? ["ESCALATE_TO_HUMAN", "REFRESH", "ABORT"];
  return actions.map((action, index) => ({
    action,
    score: Math.max(0.05, Number((diagnosis.confidence - index * 0.22).toFixed(3))),
    reason: index === 0 ? `Primary recovery for ${diagnosis.failureType}.` : `Fallback candidate #${index + 1}.`
  }));
}

export function applyPolicyGate(
  recovery: RecoveryAction,
  policy: CustomerPolicy,
  refundAmount: number | null
): PolicyDecision {
  if (recovery === "ESCALATE_TO_HUMAN" || recovery === "ABORT") {
    return { decision: "ALLOW", reason: "The proposed action is already a safe non-autonomous outcome." };
  }
  if (refundAmount !== null && (policy.requireApprovalForAllRefunds || refundAmount > policy.refundAutoExecuteLimit)) {
    if (recovery === "CONFIRM") {
      return {
        decision: "ESCALATE",
        reason: `Refund $${refundAmount.toFixed(2)} exceeds the autonomous policy boundary for ${policy.name}.`
      };
    }
  }
  return { decision: "ALLOW", reason: "Recovery action is allowed by the active customer policy." };
}

