import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowTrace } from "../browser/types.js";
import { getPolicy } from "../domain.js";

interface DatasetSample {
  sample_id: string;
  goal: string;
  workflow: string;
  customer: string;
  order_id: string;
  previous_state: string | null;
  previous_action: string | null;
  expected_next_state: string | null;
  current_state: string;
  screenshot: string;
  dom_snapshot: unknown;
  accessibility_tree: string;
  action_history: unknown[];
  customer_policy_enabled: boolean;
  customer_policy: unknown;
  failure: unknown;
  diagnosis: unknown;
  recovery_ranking: unknown[];
  executed_recovery: string | null;
  recovery_success: boolean | null;
  target_bbox: unknown;
  blocker_bbox: unknown;
}

async function main(): Promise<void> {
  const tracesRoot = path.resolve("artifacts", "traces");
  const directories = await readdir(tracesRoot, { withFileTypes: true });
  const samples: DatasetSample[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const tracePath = path.join(tracesRoot, directory.name, "trace.json");
    let trace: WorkflowTrace;
    try {
      trace = JSON.parse(await readFile(tracePath, "utf8")) as WorkflowTrace;
    } catch {
      continue;
    }
    for (const step of trace.steps.filter((entry) => entry.phase === "FAILURE" && entry.groundTruth)) {
      const previous = step.actionHistory.at(-1) ?? null;
      if (!previous?.expectedState) {
        continue;
      }
      samples.push({
        sample_id: `${trace.runId}_${step.index}`,
        goal: trace.goal,
        workflow: trace.workflow,
        customer: trace.customer,
        order_id: trace.orderId,
        previous_state: previous?.stateBefore ?? null,
        previous_action: previous?.name ?? null,
        expected_next_state: previous?.expectedState ?? null,
        current_state: step.observation.workflowState,
        screenshot: path.posix.join("artifacts", "traces", trace.runId, step.screenshot),
        dom_snapshot: step.observation.interactiveElements,
        accessibility_tree: step.observation.accessibility,
        action_history: step.actionHistory,
        customer_policy_enabled: trace.modalities.policy,
        customer_policy: trace.modalities.policy ? getPolicy(trace.customer) : null,
        failure: step.groundTruth,
        diagnosis: step.diagnosis,
        recovery_ranking: step.rankedRecoveries,
        executed_recovery: step.executedRecovery,
        recovery_success: step.recoverySucceeded,
        target_bbox: step.observation.targetBBox,
        blocker_bbox: step.observation.blockerBBox
      });
    }
  }
  await mkdir(path.resolve("artifacts", "datasets"), { recursive: true });
  const output = path.resolve("artifacts", "datasets", "workflowlens_failures.jsonl");
  await writeFile(output, samples.map((sample) => JSON.stringify(sample)).join("\n") + (samples.length ? "\n" : ""));
  console.log(JSON.stringify({ samples: samples.length, output }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

