import type { BoundingBox, WorkflowTrace } from "../browser/types.js";
import type { FailureType, RecoveryAction } from "../domain.js";

export function bboxIoU(a: BoundingBox | null, b: BoundingBox | null): number {
  if (!a || !b || a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export function pointInsideTarget(point: { x: number; y: number }, target: BoundingBox | null): boolean {
  if (!target) return false;
  return point.x >= target.x && point.x <= target.x + target.width && point.y >= target.y && point.y <= target.y + target.height;
}

export interface ClassificationMetrics {
  accuracy: number;
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  byClass: Record<string, { precision: number; recall: number; f1: number; support: number }>;
  confusion: Record<string, Record<string, number>>;
}

export function classificationMetrics(truth: string[], predicted: string[]): ClassificationMetrics {
  const labels = [...new Set([...truth, ...predicted])].sort();
  const confusion: Record<string, Record<string, number>> = {};
  for (const actual of labels) {
    confusion[actual] = {};
    for (const guess of labels) confusion[actual][guess] = 0;
  }
  for (let i = 0; i < truth.length; i += 1) confusion[truth[i]][predicted[i]] += 1;

  const byClass: ClassificationMetrics["byClass"] = {};
  for (const label of labels) {
    const tp = confusion[label][label];
    const fp = labels.reduce((sum, actual) => sum + (actual === label ? 0 : confusion[actual][label]), 0);
    const fn = labels.reduce((sum, guess) => sum + (guess === label ? 0 : confusion[label][guess]), 0);
    const support = truth.filter((value) => value === label).length;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    byClass[label] = { precision, recall, f1, support };
  }

  const values = Object.values(byClass);
  const correct = truth.reduce((sum, value, index) => sum + (value === predicted[index] ? 1 : 0), 0);
  return {
    accuracy: truth.length === 0 ? 0 : correct / truth.length,
    macroPrecision: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value.precision, 0) / values.length,
    macroRecall: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value.recall, 0) / values.length,
    macroF1: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value.f1, 0) / values.length,
    byClass,
    confusion
  };
}

export interface TraceOutcome {
  detectedFailure: FailureType | "MISSED";
  expectedFailure: FailureType;
  top1Recovery: RecoveryAction | "NONE";
  expectedRecovery: RecoveryAction;
  top3Hit: boolean;
  recoverySucceeded: boolean;
  workflowSucceeded: boolean;
  vlmCalls: number;
  durationMs: number;
}

export function traceOutcome(trace: WorkflowTrace): TraceOutcome | null {
  const failure = trace.steps.find((step) => step.phase === "FAILURE" && step.groundTruth);
  if (!failure) {
    const mutationStep = trace.steps.find((step) => step.groundTruth);
    if (!mutationStep?.groundTruth) return null;
    return {
      detectedFailure: "MISSED",
      expectedFailure: mutationStep.groundTruth.failureType,
      top1Recovery: "NONE",
      expectedRecovery: mutationStep.groundTruth.expectedRecovery,
      top3Hit: false,
      recoverySucceeded: false,
      workflowSucceeded: trace.success,
      vlmCalls: trace.vlmCalls,
      durationMs: trace.durationMs
    };
  }
  const ranked = failure.rankedRecoveries.map((entry) => entry.action);
  return {
    detectedFailure: failure.diagnosis?.failureType ?? "MISSED",
    expectedFailure: failure.groundTruth!.failureType,
    top1Recovery: ranked[0] ?? "NONE",
    expectedRecovery: failure.groundTruth!.expectedRecovery,
    top3Hit: ranked.slice(0, 3).includes(failure.groundTruth!.expectedRecovery),
    recoverySucceeded: failure.recoverySucceeded === true,
    workflowSucceeded: trace.success,
    vlmCalls: trace.vlmCalls,
    durationMs: trace.durationMs
  };
}

