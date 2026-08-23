import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runWorkflow } from "../browser/runner.js";
import type { ModalityConfig, WorkflowTrace } from "../browser/types.js";
import type { CustomerId, WorkflowId } from "../domain.js";
import type { MutationId } from "../mutations.js";
import { classificationMetrics } from "./metrics.js";

interface Case {
  workflow: WorkflowId;
  mutation: MutationId;
  customer: CustomerId;
  orderId: string;
}

const FULL_CASES: Case[] = [
  { workflow: "refund_order", mutation: "cookie_overlay", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "lookup_shipment", mutation: "unexpected_modal", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "element_moved", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "lookup_shipment", mutation: "element_renamed", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "disabled_action", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "auth_expired", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "validation_error", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "lookup_shipment", mutation: "loading_stuck", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "offscreen_target", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "lookup_shipment", mutation: "responsive_layout", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "lookup_shipment", mutation: "icon_only", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "hidden_element", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "permission_denied", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "confirmation_required", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "refund_order", mutation: "stale_state", customer: "customer_a", orderId: "ORD-18401" },
  { workflow: "lookup_shipment", mutation: "unexpected_navigation", customer: "customer_a", orderId: "ORD-18401" }
];

const QUICK_CASES = FULL_CASES.filter((entry) => ["cookie_overlay", "element_renamed", "validation_error", "permission_denied", "unexpected_navigation"].includes(entry.mutation));

const MODALITIES: Record<string, ModalityConfig> = {
  screenshot_only: { screenshot: true, dom: false, history: false, policy: false },
  screenshot_dom: { screenshot: true, dom: true, history: false, policy: false },
  screenshot_dom_history: { screenshot: true, dom: true, history: true, policy: false },
  full_policy: { screenshot: true, dom: true, history: true, policy: true }
};

function hasArg(value: string): boolean {
  return process.argv.includes(value);
}

async function main(): Promise<void> {
  const cases = hasArg("--full") ? FULL_CASES : QUICK_CASES;
  const modeNames = hasArg("--all-modalities") ? Object.keys(MODALITIES) : ["full_policy"];
  const traces: Array<{ mode: string; trace: WorkflowTrace }> = [];

  for (const mode of modeNames) {
    for (const item of cases) {
      const trace = await runWorkflow({
        workflow: item.workflow,
        mutation: item.mutation,
        customer: item.customer,
        orderId: item.orderId,
        modalities: MODALITIES[mode],
        headless: true,
        visionStrategy: "on_failure"
      });
      traces.push({ mode, trace });
      console.log(`${mode.padEnd(24)} ${item.mutation.padEnd(22)} success=${trace.success}`);
    }
  }

  const report: Record<string, unknown> = {};
  for (const mode of modeNames) {
    const selected = traces.filter((entry) => entry.mode === mode).map((entry) => entry.trace);
    const expected: string[] = [];
    const predicted: string[] = [];
    let recoveryTop1 = 0;
    let recoveryTop3 = 0;
    let diagnosed = 0;
    let recoverySuccess = 0;
    for (const trace of selected) {
      const failure = trace.steps.find((step) => step.phase === "FAILURE" && step.groundTruth);
      if (!failure?.groundTruth) {
        expected.push((await import("../mutations.js")).getMutation(trace.mutation).failureType);
        predicted.push("MISSED");
        continue;
      }
      diagnosed += 1;
      expected.push(failure.groundTruth.failureType);
      predicted.push(failure.diagnosis?.failureType ?? "MISSED");
      if (failure.rankedRecoveries[0]?.action === failure.groundTruth.expectedRecovery) recoveryTop1 += 1;
      if (failure.rankedRecoveries.slice(0, 3).some((entry) => entry.action === failure.groundTruth!.expectedRecovery)) recoveryTop3 += 1;
      if (failure.recoverySucceeded) recoverySuccess += 1;
    }
    const classification = classificationMetrics(expected, predicted);
    report[mode] = {
      cases: selected.length,
      workflowSuccessRate: selected.filter((trace) => trace.success).length / selected.length,
      diagnosisCoverage: diagnosed / selected.length,
      failureAccuracy: classification.accuracy,
      failureMacroF1: classification.macroF1,
      recoveryTop1Accuracy: diagnosed === 0 ? 0 : recoveryTop1 / diagnosed,
      recoveryTop3Accuracy: diagnosed === 0 ? 0 : recoveryTop3 / diagnosed,
      recoverySuccessRate: diagnosed === 0 ? 0 : recoverySuccess / diagnosed,
      averageVisionFallbackCalls: selected.reduce((sum, trace) => sum + trace.visionFallbackCalls, 0) / selected.length,
      averageVlmCalls: selected.reduce((sum, trace) => sum + trace.vlmCalls, 0) / selected.length,
      averageLatencyMs: Math.round(selected.reduce((sum, trace) => sum + trace.durationMs, 0) / selected.length),
      byClass: classification.byClass,
      confusion: classification.confusion
    };
  }

  await mkdir(path.resolve("artifacts", "reports"), { recursive: true });
  const filename = `benchmark_${Date.now()}.json`;
  await writeFile(path.resolve("artifacts", "reports", filename), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report=artifacts/reports/${filename}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

