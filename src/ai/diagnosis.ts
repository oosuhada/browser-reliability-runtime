import type { CustomerPolicy, FailureType } from "../domain.js";
import type {
  ActionRecord,
  BrowserObservation,
  FailureDiagnosis,
  ModalityConfig
} from "../browser/types.js";

interface DiagnosisInput {
  observation: BrowserObservation;
  history: ActionRecord[];
  goal: string;
  expectedState: string;
  expectedTargetLabel: string;
  policy: CustomerPolicy;
  modalities: ModalityConfig;
}

function result(
  failureType: FailureType,
  confidence: number,
  input: DiagnosisInput,
  evidence: string[],
  reason: string
): FailureDiagnosis {
  return {
    failureType,
    confidence,
    target: input.observation.targetId,
    blocker: input.observation.blockerId,
    evidence,
    reason
  };
}

export function diagnoseFailure(input: DiagnosisInput): FailureDiagnosis {
  const { observation, modalities } = input;
  const text = modalities.dom ? `${observation.pageText}\n${observation.accessibility}`.toLowerCase() : "";
  const target = observation.interactiveElements.find((element) => element.targetId === observation.targetId);
  const historyTail = modalities.history ? input.history.at(-1) : undefined;

  if (modalities.dom && text.includes("session expired")) {
    return result("AUTH_EXPIRED", 0.99, input, ["DOM/page text contains session expiration"], "Authentication interruption explains why the protected workflow cannot continue.");
  }
  if (modalities.dom && text.includes("permission denied")) {
    return result("PERMISSION_DENIED", 0.99, input, ["Permission banner is present"], "The operator is not authorized to perform the requested action.");
  }
  if (modalities.dom && text.includes("refund reason is required")) {
    return result("FORM_VALIDATION_ERROR", 0.98, input, ["Validation message requires a refund reason"], "The action was rejected because a required field is missing.");
  }
  if (modalities.dom && text.includes("order data changed after page load")) {
    return result("STALE_STATE", 0.97, input, ["Stale-state banner reports changed order data"], "The current page is based on stale workflow state and should be refreshed before acting.");
  }
  if (modalities.dom && observation.targetDisabled) {
    return result("DISABLED_ACTION", 0.96, input, ["Target exists but is disabled"], "The expected action is present in the DOM but cannot be executed in the current state.");
  }
  if (modalities.screenshot && observation.overlayPresent && observation.blockerId === "loading_overlay") {
    return result("LOADING_STUCK", 0.95, input, ["Full-page loading blocker remains visible"], "A persistent loading layer prevents the workflow from progressing.");
  }
  if (modalities.dom && observation.overlayPresent && observation.blockerId === "confirmation_modal") {
    return result("CONFIRMATION_REQUIRED", 0.96, input, ["Confirmation dialog is present after the primary action"], "The workflow inserted an additional confirmation step.");
  }
  if (modalities.dom && observation.overlayPresent && observation.blockerId === "announcement_modal") {
    return result("UNEXPECTED_MODAL", 0.95, input, ["Announcement modal is not part of the expected workflow transition"], "An unrelated modal interrupts the expected action path.");
  }
  if (modalities.screenshot && observation.overlayPresent && observation.occlusionRatio > 0.15) {
    return result("OCCLUDED_TARGET", 0.96, input, [`Blocker overlaps ${Math.round(observation.occlusionRatio * 100)}% of target`], "The target still exists but a visual blocker intercepts interaction.");
  }
  if (modalities.dom && observation.overlayPresent) {
    return result("UNEXPECTED_MODAL", 0.88, input, [`Unexpected blocker ${observation.blockerId ?? "modal"} is visible`], "An unexpected modal interrupts the expected action path.");
  }
  if (modalities.screenshot && observation.targetVisible && !observation.targetInViewport) {
    return result("OFFSCREEN_TARGET", 0.93, input, ["Target bounding box is outside the current viewport"], "The target exists but requires scrolling before interaction.");
  }
  if (modalities.dom && target?.visible === false) {
    return result("HIDDEN_ELEMENT", 0.91, input, ["Target exists in DOM but has no visible bounding box"], "The primary target is hidden and a semantic alternative is required.");
  }
  if (modalities.dom && target) {
    if (!/[a-z0-9]/i.test(target.text) && target.ariaLabel) {
      return result("ICON_ONLY_TARGET", 0.94, input, ["Visible target is symbolic while the accessible label preserves intent"], "The text label was replaced by an icon-only control.");
    }
    const label = `${target.text} ${target.ariaLabel ?? ""}`.trim().toLowerCase();
    const expected = input.expectedTargetLabel.toLowerCase();
    if (expected && !label.includes(expected)) {
      return result("ELEMENT_RENAMED", 0.86, input, [`Observed label '${label}' differs from expected '${expected}'`], "The target semantics remain available but the visible label changed.");
    }
  }
  if (modalities.history && historyTail && observation.workflowState === "UNKNOWN" && historyTail.success) {
    return result("NAVIGATION_ERROR", 0.94, input, [`Action succeeded but current state is UNKNOWN instead of ${input.expectedState}`], "The action navigated to a valid page that does not match the workflow transition.");
  }
  if (modalities.screenshot && observation.workflowState === "ORDER_DETAIL" && observation.targetVisible && observation.targetBBox && target?.fixedAncestor) {
    return result("RESPONSIVE_LAYOUT_CHANGE", 0.84, input, ["Target moved into a detached edge action rail"], "The current geometry matches a compact responsive layout rather than the expected desktop action row.");
  }
  if (modalities.screenshot && observation.workflowState === "ORDER_DETAIL" && observation.targetVisible && observation.targetBBox && observation.targetBBox.y > 500) {
    return result("ELEMENT_MOVED", 0.72, input, ["Target appears in an atypical lower-page position"], "The target remains usable but has moved away from its expected action region.");
  }

  return result("UNKNOWN_STATE", 0.45, input, ["No high-confidence diagnostic rule matched the available modalities"], "The observed state does not match the expected workflow transition, but evidence is insufficient for a specific class.");
}

