import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runWorkflow } from "../browser/runner.js";
import type { MutationId } from "../mutations.js";
import { classificationMetrics } from "./metrics.js";

const MUTATIONS: MutationId[] = [
  "unexpected_modal",
  "auth_expired",
  "permission_denied",
  "confirmation_required",
  "stale_state"
];

async function main(): Promise<void> {
  const traces = [];
  for (const mutation of MUTATIONS) {
    const trace = await runWorkflow({
      workflow: "approve_refund",
      mutation,
      customer: "customer_a",
      orderId: "ORD-18401",
      modalities: { screenshot: true, dom: true, history: true, policy: true },
      headless: true,
      visionStrategy: "on_failure",
      reasoner: "heuristic"
    });
    traces.push(trace);
    const failure = trace.steps.find((step) => step.phase === "FAILURE" && step.groundTruth);
    console.log(`${mutation.padEnd(22)} expected=${failure?.groundTruth?.failureType ?? "missing"} predicted=${failure?.diagnosis?.failureType ?? "missing"} recovery=${failure?.executedRecovery ?? "missing"}`);
  }

  const expected: string[] = [];
  const predicted: string[] = [];
  let recoveryTop1 = 0;
  let recoveryTop3 = 0;
  let expectedRecoverySuccess = 0;
  for (const trace of traces) {
    const failure = trace.steps.find((step) => step.phase === "FAILURE" && step.groundTruth);
    if (!failure?.groundTruth) continue;
    expected.push(failure.groundTruth.failureType);
    predicted.push(failure.diagnosis?.failureType ?? "MISSED");
    if (failure.rankedRecoveries[0]?.action === failure.groundTruth.expectedRecovery) recoveryTop1 += 1;
    if (failure.rankedRecoveries.slice(0, 3).some((item) => item.action === failure.groundTruth?.expectedRecovery)) recoveryTop3 += 1;
    if (failure.recoverySucceeded && failure.executedRecovery === failure.groundTruth.expectedRecovery) expectedRecoverySuccess += 1;
  }

  const classification = classificationMetrics(expected, predicted);
  const diagnosed = expected.length;
  const report = {
    schema: "workflowlens.workflow-generalization.v1",
    workflow: "approve_refund",
    trainingDatasetIncludesWorkflow: false,
    cases: traces.length,
    workflowResolutionRate: traces.filter((trace) => trace.success).length / traces.length,
    taskCompletionRate: traces.filter((trace) => trace.taskCompleted).length / traces.length,
    safeEscalationRate: traces.filter((trace) => trace.safeEscalation).length / traces.length,
    diagnosisCoverage: diagnosed / traces.length,
    failureAccuracy: classification.accuracy,
    failureMacroF1: classification.macroF1,
    recoveryTop1Accuracy: diagnosed ? recoveryTop1 / diagnosed : 0,
    recoveryTop3Accuracy: diagnosed ? recoveryTop3 / diagnosed : 0,
    expectedRecoverySuccessRate: diagnosed ? expectedRecoverySuccess / diagnosed : 0,
    averageLatencyMs: Math.round(traces.reduce((sum, trace) => sum + trace.durationMs, 0) / traces.length),
    mutations: MUTATIONS,
    byClass: classification.byClass,
    confusion: classification.confusion
  };
  const reportDir = path.resolve("artifacts", "reports");
  await mkdir(reportDir, { recursive: true });
  const output = path.join(reportDir, `generalization_approval_${Date.now()}.json`);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report=${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
