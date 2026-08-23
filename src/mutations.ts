import type { FailureType, RecoveryAction, WorkflowState } from "./domain.js";

export type MutationId =
  | "none"
  | "cookie_overlay"
  | "unexpected_modal"
  | "element_moved"
  | "element_renamed"
  | "disabled_action"
  | "auth_expired"
  | "validation_error"
  | "loading_stuck"
  | "offscreen_target"
  | "responsive_layout"
  | "icon_only"
  | "hidden_element"
  | "permission_denied"
  | "confirmation_required"
  | "stale_state"
  | "unexpected_navigation";

export interface MutationDefinition {
  id: MutationId;
  label: string;
  failureType: FailureType;
  targetId: string | null;
  blocker: string | null;
  expectedRecovery: RecoveryAction;
  applicableStates: WorkflowState[];
  description: string;
}

export const MUTATIONS: Record<MutationId, MutationDefinition> = {
  none: {
    id: "none",
    label: "No mutation",
    failureType: "NONE",
    targetId: null,
    blocker: null,
    expectedRecovery: "NONE",
    applicableStates: ["LOGIN", "ORDERS", "ORDER_DETAIL", "SHIPMENT", "REFUND"],
    description: "Normal workflow without an injected failure."
  },
  cookie_overlay: {
    id: "cookie_overlay",
    label: "Cookie overlay",
    failureType: "OCCLUDED_TARGET",
    targetId: "refund_button",
    blocker: "cookie_consent_modal",
    expectedRecovery: "CLOSE_MODAL",
    applicableStates: ["ORDER_DETAIL"],
    description: "A cookie consent overlay blocks the primary refund action."
  },
  unexpected_modal: {
    id: "unexpected_modal",
    label: "Unexpected modal",
    failureType: "UNEXPECTED_MODAL",
    targetId: "shipment_lookup_button",
    blocker: "announcement_modal",
    expectedRecovery: "CLOSE_MODAL",
    applicableStates: ["ORDER_DETAIL"],
    description: "An unexpected announcement modal intercepts pointer events."
  },
  element_moved: {
    id: "element_moved",
    label: "Element moved",
    failureType: "ELEMENT_MOVED",
    targetId: "refund_button",
    blocker: null,
    expectedRecovery: "USE_ALTERNATIVE_TARGET",
    applicableStates: ["ORDER_DETAIL"],
    description: "The target remains available but is relocated to a secondary action area."
  },
  element_renamed: {
    id: "element_renamed",
    label: "Element renamed",
    failureType: "ELEMENT_RENAMED",
    targetId: "shipment_lookup_button",
    blocker: null,
    expectedRecovery: "USE_ALTERNATIVE_TARGET",
    applicableStates: ["ORDER_DETAIL"],
    description: "The visible action label changes while semantic intent stays the same."
  },
  disabled_action: {
    id: "disabled_action",
    label: "Button disabled",
    failureType: "DISABLED_ACTION",
    targetId: "execute_refund_button",
    blocker: null,
    expectedRecovery: "ESCALATE_TO_HUMAN",
    applicableStates: ["REFUND"],
    description: "The refund action is present but disabled."
  },
  auth_expired: {
    id: "auth_expired",
    label: "Session expired",
    failureType: "AUTH_EXPIRED",
    targetId: "refund_button",
    blocker: "session_expired_modal",
    expectedRecovery: "REAUTHENTICATE",
    applicableStates: ["ORDER_DETAIL", "REFUND"],
    description: "The session expires immediately before a protected action."
  },
  validation_error: {
    id: "validation_error",
    label: "Validation error",
    failureType: "FORM_VALIDATION_ERROR",
    targetId: "execute_refund_button",
    blocker: "refund_reason_required",
    expectedRecovery: "FILL_REQUIRED_FIELD",
    applicableStates: ["REFUND"],
    description: "A required refund reason is missing."
  },
  loading_stuck: {
    id: "loading_stuck",
    label: "Loading stuck",
    failureType: "LOADING_STUCK",
    targetId: "shipment_lookup_button",
    blocker: "loading_overlay",
    expectedRecovery: "REFRESH",
    applicableStates: ["ORDER_DETAIL", "SHIPMENT"],
    description: "A loading state never resolves."
  },
  offscreen_target: {
    id: "offscreen_target",
    label: "Offscreen target",
    failureType: "OFFSCREEN_TARGET",
    targetId: "refund_button",
    blocker: null,
    expectedRecovery: "SCROLL",
    applicableStates: ["ORDER_DETAIL"],
    description: "The target is pushed below a tall injected content block."
  },
  responsive_layout: {
    id: "responsive_layout",
    label: "Responsive layout change",
    failureType: "RESPONSIVE_LAYOUT_CHANGE",
    targetId: "shipment_lookup_button",
    blocker: null,
    expectedRecovery: "CHANGE_VIEWPORT",
    applicableStates: ["ORDER_DETAIL"],
    description: "The action moves into a compact mobile-style action rail."
  },
  icon_only: {
    id: "icon_only",
    label: "Icon-only target",
    failureType: "ICON_ONLY_TARGET",
    targetId: "shipment_lookup_button",
    blocker: null,
    expectedRecovery: "USE_ALTERNATIVE_TARGET",
    applicableStates: ["ORDER_DETAIL"],
    description: "The visible text disappears but an accessible label remains."
  },
  hidden_element: {
    id: "hidden_element",
    label: "Hidden target",
    failureType: "HIDDEN_ELEMENT",
    targetId: "refund_button",
    blocker: null,
    expectedRecovery: "USE_ALTERNATIVE_TARGET",
    applicableStates: ["ORDER_DETAIL"],
    description: "The primary target is hidden while a semantic alternative remains available."
  },
  permission_denied: {
    id: "permission_denied",
    label: "Permission denied",
    failureType: "PERMISSION_DENIED",
    targetId: "execute_refund_button",
    blocker: "permission_banner",
    expectedRecovery: "ESCALATE_TO_HUMAN",
    applicableStates: ["REFUND"],
    description: "The current operator lacks the permission required to execute a refund."
  },
  confirmation_required: {
    id: "confirmation_required",
    label: "Confirmation required",
    failureType: "CONFIRMATION_REQUIRED",
    targetId: "execute_refund_button",
    blocker: "confirmation_modal",
    expectedRecovery: "CONFIRM",
    applicableStates: ["REFUND"],
    description: "An extra safety confirmation is inserted before execution."
  },
  stale_state: {
    id: "stale_state",
    label: "Stale state",
    failureType: "STALE_STATE",
    targetId: "execute_refund_button",
    blocker: "stale_state_banner",
    expectedRecovery: "REFRESH",
    applicableStates: ["REFUND"],
    description: "The order changed after the page loaded and requires a refresh."
  },
  unexpected_navigation: {
    id: "unexpected_navigation",
    label: "Unexpected navigation",
    failureType: "NAVIGATION_ERROR",
    targetId: "shipment_lookup_button",
    blocker: null,
    expectedRecovery: "RETURN_PREVIOUS_STEP",
    applicableStates: ["ORDER_DETAIL"],
    description: "The intended action routes to an unrelated maintenance page."
  }
};

export function getMutation(raw: string | undefined): MutationDefinition {
  if (raw && raw in MUTATIONS) {
    return MUTATIONS[raw as MutationId];
  }
  return MUTATIONS.none;
}

export function mutationApplies(mutation: MutationDefinition, state: WorkflowState): boolean {
  return mutation.id !== "none" && mutation.applicableStates.includes(state);
}

