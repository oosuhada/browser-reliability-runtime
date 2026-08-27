import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FailureType, RecoveryAction } from "../domain.js";
import { writeJob } from "./queue.js";
import type { LocalLlmQueueJob } from "./types.js";

interface DatasetRow {
  sample_id: string;
  goal: string;
  order_id: string;
  previous_state: string | null;
  previous_action: string | null;
  expected_next_state?: string | null;
  current_state: string;
  screenshot: string;
  dom_snapshot: unknown;
  accessibility_tree: string;
  action_history: unknown[];
  customer_policy: unknown;
  failure: {
    mutation: string;
    failureType: FailureType;
    expectedRecovery: RecoveryAction;
  };
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main(): Promise<void> {
  const input = arg("input") ?? "artifacts/datasets/workflowlens_failures.jsonl";
  const mutations = new Set((arg("mutations") ?? "auth_expired,responsive_layout,unexpected_navigation").split(",").filter(Boolean));
  const requiresVision = arg("vision") === "true";
  const requestedModel = arg("model");
  const limit = Number(arg("limit") ?? 0);
  const batchId = arg("batch") ?? `local_llm_${Date.now()}`;
  const sourceRows = (await readFile(path.resolve(input), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DatasetRow)
    .filter((row) => mutations.size === 0 || mutations.has(row.failure.mutation));

  const deduplicated = new Map<string, DatasetRow>();
  for (const row of sourceRows) {
    const signature = [
      row.failure.mutation,
      row.order_id,
      row.previous_state,
      row.previous_action,
      row.expected_next_state,
      row.current_state
    ].join("|");
    if (!deduplicated.has(signature)) deduplicated.set(signature, row);
  }
  const rows = [...deduplicated.values()];

  const selected = limit > 0 ? rows.slice(0, limit) : rows;
  let enqueued = 0;
  for (const row of selected) {
    const now = new Date().toISOString();
    const job: LocalLlmQueueJob = {
      schemaVersion: "1.0",
      id: `${batchId}_${row.sample_id}_${requiresVision ? "vision" : "text"}`,
      batchId,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      attempts: 0,
      requiresVision,
      requestedModel,
      blockedReason: null,
      evidence: {
        sampleId: row.sample_id,
        goal: row.goal,
        previousState: row.previous_state,
        previousAction: row.previous_action,
        expectedNextState: row.expected_next_state ?? null,
        currentState: row.current_state,
        domSnapshot: row.dom_snapshot,
        accessibilityTree: row.accessibility_tree,
        actionHistory: row.action_history,
        customerPolicy: row.customer_policy,
        screenshotPath: requiresVision ? row.screenshot : null
      },
      expected: {
        failureType: row.failure.failureType,
        recovery: row.failure.expectedRecovery
      }
    };
    await writeJob(job);
    enqueued += 1;
  }

  console.log(JSON.stringify({
    batchId,
    sourceRows: sourceRows.length,
    deduplicatedRows: rows.length,
    enqueued,
    requiresVision,
    requestedModel,
    input
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

