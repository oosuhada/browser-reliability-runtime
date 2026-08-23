import type {
  CustomerId,
  FailureType,
  RecoveryAction,
  WorkflowId,
  WorkflowState
} from "../domain.js";
import type { MutationId } from "../mutations.js";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InteractiveElementSnapshot {
  tag: string;
  role: string | null;
  text: string;
  ariaLabel: string | null;
  targetId: string | null;
  disabled: boolean;
  visible: boolean;
  position: string;
  fixedAncestor: boolean;
  bbox: BoundingBox | null;
}

export interface BrowserObservation {
  url: string;
  title: string;
  workflowState: WorkflowState;
  pageText: string;
  accessibility: string;
  interactiveElements: InteractiveElementSnapshot[];
  targetId: string | null;
  targetBBox: BoundingBox | null;
  blockerBBox: BoundingBox | null;
  blockerId: string | null;
  targetVisible: boolean;
  targetDisabled: boolean;
  targetInViewport: boolean;
  occlusionRatio: number;
  overlayPresent: boolean;
  viewport: { width: number; height: number };
}

export interface ActionRecord {
  name: string;
  targetId: string | null;
  selector: string | null;
  success: boolean;
  error: string | null;
  stateBefore: WorkflowState;
  stateAfter: WorkflowState;
  urlBefore: string;
  urlAfter: string;
}

export interface ModalityConfig {
  screenshot: boolean;
  dom: boolean;
  history: boolean;
  policy: boolean;
}

export type VisionStrategy = "always" | "on_failure" | "on_low_confidence";

export interface FailureDiagnosis {
  failureType: FailureType;
  confidence: number;
  target: string | null;
  blocker: string | null;
  evidence: string[];
  reason: string;
}

export interface RankedRecovery {
  action: RecoveryAction;
  score: number;
  reason: string;
}

export interface PolicyDecision {
  decision: "ALLOW" | "ESCALATE";
  reason: string;
}

export interface GroundTruth {
  mutation: MutationId;
  failureType: FailureType;
  target: string | null;
  blocker: string | null;
  expectedRecovery: RecoveryAction;
}

export interface TraceStep {
  index: number;
  phase: "NORMAL_ACTION" | "FAILURE" | "RECOVERY" | "VERIFY";
  timestamp: string;
  screenshot: string;
  observation: BrowserObservation;
  action: ActionRecord | null;
  actionHistory: ActionRecord[];
  groundTruth: GroundTruth | null;
  diagnosis: FailureDiagnosis | null;
  rankedRecoveries: RankedRecovery[];
  policyDecision: PolicyDecision | null;
  executedRecovery: RecoveryAction | null;
  recoverySucceeded: boolean | null;
}

export interface WorkflowTrace {
  schemaVersion: "1.0";
  runId: string;
  startedAt: string;
  completedAt: string;
  baseUrl: string;
  workflow: WorkflowId;
  goal: string;
  customer: CustomerId;
  orderId: string;
  mutation: MutationId;
  modalities: ModalityConfig;
  visionStrategy: VisionStrategy;
  reasoner: "heuristic" | "vlm";
  success: boolean;
  safeEscalation: boolean;
  visionFallbackCalls: number;
  vlmCalls: number;
  durationMs: number;
  steps: TraceStep[];
}

