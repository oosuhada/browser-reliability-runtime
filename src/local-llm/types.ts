import type { FailureType, RecoveryAction } from "../domain.js";

export type LocalLlmQueueStatus = "pending" | "running" | "blocked" | "completed" | "failed";

export interface LocalLlmEvidence {
  sampleId: string;
  goal: string;
  previousState: string | null;
  previousAction: string | null;
  expectedNextState: string | null;
  currentState: string;
  domSnapshot: unknown;
  accessibilityTree: string;
  actionHistory: unknown[];
  customerPolicy: unknown;
  screenshotPath: string | null;
}

export interface LocalLlmExpected {
  failureType: FailureType;
  recovery: RecoveryAction;
}

export interface LocalLlmQueueJob {
  schemaVersion: "1.0";
  id: string;
  batchId: string;
  createdAt: string;
  updatedAt: string;
  status: LocalLlmQueueStatus;
  attempts: number;
  requiresVision: boolean;
  requestedModel: string | null;
  blockedReason: string | null;
  evidence: LocalLlmEvidence;
  expected: LocalLlmExpected;
}

export interface LocalLlmPrediction {
  failure_type: string;
  recovery: string;
  confidence: number;
  reason: string;
}

export interface LocalLlmCompletedJob extends LocalLlmQueueJob {
  status: "completed";
  result: {
    model: string;
    latencyMs: number;
    prediction: LocalLlmPrediction;
    rawContent: string;
  };
}

