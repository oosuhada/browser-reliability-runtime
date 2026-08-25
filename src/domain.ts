export type CustomerId = "customer_a" | "customer_b";

export type WorkflowId = "refund_order" | "lookup_shipment" | "approve_refund";

export type WorkflowState =
  | "LOGIN"
  | "ORDERS"
  | "ORDER_DETAIL"
  | "SHIPMENT"
  | "REFUND"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_QUEUE"
  | "APPROVAL_DETAIL"
  | "COMPLETE"
  | "AUTH_INTERRUPTED"
  | "PERMISSION_BLOCKED"
  | "LOADING"
  | "UNKNOWN";

export type FailureType =
  | "NONE"
  | "ELEMENT_MOVED"
  | "ELEMENT_RENAMED"
  | "OCCLUDED_TARGET"
  | "UNEXPECTED_MODAL"
  | "OFFSCREEN_TARGET"
  | "RESPONSIVE_LAYOUT_CHANGE"
  | "AUTH_EXPIRED"
  | "PERMISSION_DENIED"
  | "FORM_VALIDATION_ERROR"
  | "DISABLED_ACTION"
  | "LOADING_STUCK"
  | "NAVIGATION_ERROR"
  | "HIDDEN_ELEMENT"
  | "STALE_STATE"
  | "CONFIRMATION_REQUIRED"
  | "ICON_ONLY_TARGET"
  | "UNKNOWN_STATE";

export type RecoveryAction =
  | "NONE"
  | "RETRY"
  | "SCROLL"
  | "CLOSE_MODAL"
  | "REFRESH"
  | "REAUTHENTICATE"
  | "USE_ALTERNATIVE_TARGET"
  | "RETURN_PREVIOUS_STEP"
  | "WAIT"
  | "CHANGE_VIEWPORT"
  | "ESCALATE_TO_HUMAN"
  | "FILL_REQUIRED_FIELD"
  | "CONFIRM"
  | "ABORT";

export interface CustomerPolicy {
  id: CustomerId;
  name: string;
  refundAutoExecuteLimit: number;
  requireApprovalForAllRefunds: boolean;
  allowForceClick: boolean;
  modalStrategy: "close_then_retry" | "escalate";
}

export interface Order {
  id: string;
  customer: string;
  total: number;
  status: "Paid" | "Shipped" | "Delivered";
  shipmentId: string;
  carrier: string;
}

export const ORDERS: Order[] = [
  {
    id: "ORD-18392",
    customer: "Mina Park",
    total: 720,
    status: "Delivered",
    shipmentId: "SHP-94211",
    carrier: "Workflow Express"
  },
  {
    id: "ORD-18401",
    customer: "Alex Kim",
    total: 120,
    status: "Shipped",
    shipmentId: "SHP-94272",
    carrier: "Workflow Express"
  },
  {
    id: "ORD-18412",
    customer: "Jin Lee",
    total: 48,
    status: "Paid",
    shipmentId: "SHP-94303",
    carrier: "Parcel Lab"
  }
];

export const POLICIES: Record<CustomerId, CustomerPolicy> = {
  customer_a: {
    id: "customer_a",
    name: "Customer A — Balanced Automation",
    refundAutoExecuteLimit: 500,
    requireApprovalForAllRefunds: false,
    allowForceClick: false,
    modalStrategy: "close_then_retry"
  },
  customer_b: {
    id: "customer_b",
    name: "Customer B — Human Approval",
    refundAutoExecuteLimit: 0,
    requireApprovalForAllRefunds: true,
    allowForceClick: false,
    modalStrategy: "close_then_retry"
  }
};

export function getOrder(orderId: string): Order {
  return ORDERS.find((order) => order.id === orderId) ?? ORDERS[0];
}

export function getPolicy(customer: string | undefined): CustomerPolicy {
  return POLICIES[customer === "customer_b" ? "customer_b" : "customer_a"];
}

export function requiresHumanApproval(policy: CustomerPolicy, amount: number): boolean {
  return policy.requireApprovalForAllRefunds || amount > policy.refundAutoExecuteLimit;
}

