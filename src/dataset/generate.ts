import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runWorkflow } from "../browser/runner.js";
import type { WorkflowId } from "../domain.js";
import type { MutationId } from "../mutations.js";

interface GenerationCase {
  workflow: WorkflowId;
  mutation: MutationId;
  orderIds: string[];
}

const ALL_ORDERS = ["ORD-18392", "ORD-18401", "ORD-18412"];
const AUTONOMOUS_REFUND_ORDERS = ["ORD-18401", "ORD-18412"];

const CASES: GenerationCase[] = [
  { workflow: "refund_order", mutation: "cookie_overlay", orderIds: ALL_ORDERS },
  { workflow: "lookup_shipment", mutation: "unexpected_modal", orderIds: ALL_ORDERS },
  { workflow: "refund_order", mutation: "element_moved", orderIds: ALL_ORDERS },
  { workflow: "lookup_shipment", mutation: "element_renamed", orderIds: ALL_ORDERS },
  { workflow: "refund_order", mutation: "disabled_action", orderIds: AUTONOMOUS_REFUND_ORDERS },
  { workflow: "refund_order", mutation: "auth_expired", orderIds: ALL_ORDERS },
  { workflow: "refund_order", mutation: "validation_error", orderIds: AUTONOMOUS_REFUND_ORDERS },
  { workflow: "lookup_shipment", mutation: "loading_stuck", orderIds: ALL_ORDERS },
  { workflow: "refund_order", mutation: "offscreen_target", orderIds: ALL_ORDERS },
  { workflow: "lookup_shipment", mutation: "responsive_layout", orderIds: ALL_ORDERS },
  { workflow: "lookup_shipment", mutation: "icon_only", orderIds: ALL_ORDERS },
  { workflow: "refund_order", mutation: "hidden_element", orderIds: ALL_ORDERS },
  { workflow: "refund_order", mutation: "permission_denied", orderIds: AUTONOMOUS_REFUND_ORDERS },
  { workflow: "refund_order", mutation: "confirmation_required", orderIds: AUTONOMOUS_REFUND_ORDERS },
  { workflow: "refund_order", mutation: "stale_state", orderIds: AUTONOMOUS_REFUND_ORDERS },
  { workflow: "lookup_shipment", mutation: "unexpected_navigation", orderIds: ALL_ORDERS }
];

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runs = [];
  const requestedMutation = process.argv.find((value) => value.startsWith("--mutation="))?.slice("--mutation=".length);
  const generationCases = requestedMutation
    ? CASES.filter((generationCase) => generationCase.mutation === requestedMutation)
    : CASES;

  if (generationCases.length === 0) {
    throw new Error(`Unknown or unsupported mutation filter: ${requestedMutation}`);
  }

  for (const generationCase of generationCases) {
    for (const orderId of generationCase.orderIds) {
      const trace = await runWorkflow({
        workflow: generationCase.workflow,
        customer: "customer_a",
        mutation: generationCase.mutation,
        orderId,
        modalities: {
          screenshot: true,
          dom: true,
          history: true,
          policy: true
        },
        headless: true,
        visionStrategy: "on_failure",
        reasoner: "heuristic"
      });

      const failure = trace.steps.find((step) => step.phase === "FAILURE" && step.groundTruth);
      runs.push({
        runId: trace.runId,
        workflow: trace.workflow,
        mutation: trace.mutation,
        orderId: trace.orderId,
        failureGenerated: Boolean(failure),
        expectedFailure: failure?.groundTruth?.failureType ?? null,
        diagnosedFailure: failure?.diagnosis?.failureType ?? null,
        expectedRecovery: failure?.groundTruth?.expectedRecovery ?? null,
        executedRecovery: failure?.executedRecovery ?? null,
        taskCompleted: trace.taskCompleted,
        safeEscalation: trace.safeEscalation,
        durationMs: trace.durationMs
      });

      console.log(
        `${generationCase.mutation.padEnd(22)} ${orderId} failure=${Boolean(failure)} diagnosis=${failure?.diagnosis?.failureType ?? "none"}`
      );
    }
  }

  const missingFailures = runs.filter((run) => !run.failureGenerated);
  const mismatchedDiagnosis = runs.filter(
    (run) => run.failureGenerated && run.expectedFailure !== run.diagnosedFailure
  );
  const mismatchedRecovery = runs.filter(
    (run) => run.failureGenerated && run.expectedRecovery !== run.executedRecovery
  );
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    runs: runs.length,
    mutationClasses: new Set(runs.map((run) => run.mutation)).size,
    generatedFailures: runs.filter((run) => run.failureGenerated).length,
    missingFailures: missingFailures.map((run) => `${run.mutation}:${run.orderId}`),
    diagnosisMismatches: mismatchedDiagnosis.map((run) => `${run.mutation}:${run.orderId}`),
    recoveryMismatches: mismatchedRecovery.map((run) => `${run.mutation}:${run.orderId}`),
    details: runs
  };

  await mkdir(path.resolve("artifacts", "reports"), { recursive: true });
  const filename = `dataset_generation_${Date.now()}.json`;
  await writeFile(path.resolve("artifacts", "reports", filename), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report=artifacts/reports/${filename}`);

  if (missingFailures.length || mismatchedDiagnosis.length || mismatchedRecovery.length) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
