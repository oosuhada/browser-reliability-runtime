import { readFile } from "node:fs/promises";
import path from "node:path";

interface DatasetRow {
  sample_id: string;
  goal: string;
  previous_state: string | null;
  previous_action: string | null;
  expected_next_state: string | null;
  current_state: string;
  dom_snapshot: unknown;
  accessibility_tree: string;
  action_history: unknown[];
  customer_policy: unknown;
  failure: {
    mutation?: string;
    failureType?: string;
    expectedRecovery?: string;
  } | null;
}

async function main(): Promise<void> {
  const filename = process.argv.find((value) => value.startsWith("--input="))?.slice("--input=".length)
    ?? path.resolve("artifacts", "datasets", "workflowlens_failures.jsonl");
  const text = await readFile(filename, "utf8");
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as DatasetRow);
  const violations: Array<{ sampleId: string; leaked: string }> = [];

  for (const row of rows) {
    const inputPayload = JSON.stringify({
      goal: row.goal,
      previousState: row.previous_state,
      previousAction: row.previous_action,
      expectedNextState: row.expected_next_state,
      currentState: row.current_state,
      dom: row.dom_snapshot,
      accessibility: row.accessibility_tree,
      history: row.action_history,
      policy: row.customer_policy
    });
    const forbidden = [
      row.failure?.mutation,
      row.failure?.failureType,
      row.failure?.expectedRecovery
    ].filter((value): value is string => Boolean(value && value !== "none"));

    for (const value of forbidden) {
      if (inputPayload.includes(value)) {
        violations.push({ sampleId: row.sample_id, leaked: value });
      }
    }
  }

  const report = {
    samples: rows.length,
    leakageViolations: violations.length,
    violations: violations.slice(0, 50)
  };
  console.log(JSON.stringify(report, null, 2));
  if (violations.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
