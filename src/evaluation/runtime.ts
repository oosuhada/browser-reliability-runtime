import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runWorkflow } from "../browser/runner.js";
import type { VisionStrategy } from "../browser/types.js";

const CASES = [
  { workflow: "refund_order" as const, mutation: "none" as const },
  { workflow: "refund_order" as const, mutation: "cookie_overlay" as const },
  { workflow: "lookup_shipment" as const, mutation: "element_renamed" as const },
  { workflow: "refund_order" as const, mutation: "validation_error" as const },
  { workflow: "lookup_shipment" as const, mutation: "unexpected_navigation" as const }
];

const STRATEGIES: VisionStrategy[] = ["always", "on_failure", "on_low_confidence"];
const ESTIMATED_VLM_LATENCY_MS = Number(process.env.VLM_ESTIMATED_LATENCY_MS ?? 800);
const ESTIMATED_VLM_COST_USD = Number(process.env.VLM_ESTIMATED_COST_USD ?? 0.002);

async function main(): Promise<void> {
  const report: Record<string, unknown> = {};
  for (const strategy of STRATEGIES) {
    const traces = [];
    for (const item of CASES) {
      const trace = await runWorkflow({
        workflow: item.workflow,
        mutation: item.mutation,
        customer: "customer_a",
        orderId: "ORD-18401",
        modalities: { screenshot: true, dom: true, history: true, policy: true },
        headless: true,
        visionStrategy: strategy
      });
      traces.push(trace);
    }
    const calls = traces.reduce((sum, trace) => sum + trace.visionFallbackCalls, 0);
    const measuredLatency = traces.reduce((sum, trace) => sum + trace.durationMs, 0) / traces.length;
    const avgCalls = calls / traces.length;
    const failureCases = traces.filter((trace) => trace.steps.some((step) => step.phase === "FAILURE"));
    report[strategy] = {
      workflowResolutionRate: traces.filter((trace) => trace.success).length / traces.length,
      taskCompletionRate: traces.filter((trace) => trace.taskCompleted).length / traces.length,
      safeEscalationRate: traces.filter((trace) => trace.safeEscalation).length / traces.length,
      recoveryResolutionRate: failureCases.length === 0 ? 1 : failureCases.filter((trace) => trace.success).length / failureCases.length,
      averageVisionFallbackCalls: avgCalls,
      measuredBrowserRuntimeMs: Math.round(measuredLatency),
      estimatedVlmLatencyMs: Math.round(avgCalls * ESTIMATED_VLM_LATENCY_MS),
      estimatedEndToEndLatencyMs: Math.round(measuredLatency + avgCalls * ESTIMATED_VLM_LATENCY_MS),
      estimatedInferenceCostUsd: Number((avgCalls * ESTIMATED_VLM_COST_USD).toFixed(5)),
      note: "VLM latency/cost are configurable estimates; browser runtime is measured locally."
    };
  }
  await mkdir(path.resolve("artifacts", "reports"), { recursive: true });
  const filename = `runtime_${Date.now()}.json`;
  await writeFile(path.resolve("artifacts", "reports", filename), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report=artifacts/reports/${filename}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

