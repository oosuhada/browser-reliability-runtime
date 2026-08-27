import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActionRecord, WorkflowTrace } from "../browser/types.js";
import type { WorkflowState } from "../domain.js";

function transitionMatches(action: ActionRecord): boolean {
  if (action.expectedState === "TERMINAL") {
    return ["COMPLETE", "APPROVAL_REQUIRED"].includes(action.stateAfter);
  }
  return action.stateAfter === action.expectedState;
}

function expectedStateMismatch(action: ActionRecord): boolean {
  return !transitionMatches(action);
}

async function main(): Promise<void> {
  const tracesRoot = path.resolve("artifacts", "traces");
  const directories = await readdir(tracesRoot, { withFileTypes: true });
  const traces: WorkflowTrace[] = [];

  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      const trace = JSON.parse(
        await readFile(path.join(tracesRoot, directory.name, "trace.json"), "utf8")
      ) as WorkflowTrace;
      const hasExpectedState = trace.steps.some((step) =>
        step.actionHistory.some((action) => Boolean(action.expectedState))
      );
      if (hasExpectedState) traces.push(trace);
    } catch {
      // Ignore incomplete or legacy trace directories.
    }
  }

  const actions = traces.flatMap((trace) => trace.steps)
    .map((step) => step.action)
    .filter((action): action is ActionRecord => Boolean(action?.expectedState));

  const failureSteps = traces.flatMap((trace) => trace.steps)
    .filter((step) => step.phase === "FAILURE");

  const failureTransitions = failureSteps
    .map((step) => step.actionHistory.at(-1))
    .filter((action): action is ActionRecord => Boolean(action?.expectedState));

  const transitionMatchesCount = actions.filter(transitionMatches).length;
  const mismatchFailures = failureTransitions.filter(expectedStateMismatch).length;
  const report = {
    traces: traces.length,
    actions: actions.length,
    immediateTransitionSuccessRate: actions.length ? transitionMatchesCount / actions.length : 0,
    failureSteps: failureTransitions.length,
    failureTransitionMismatchRecall: failureTransitions.length
      ? mismatchFailures / failureTransitions.length
      : 0,
    byExpectedState: Object.fromEntries(
      [...new Set(actions.map((action) => action.expectedState))].sort().map((expectedState) => {
        const selected = actions.filter((action) => action.expectedState === expectedState);
        return [
          expectedState,
          {
            actions: selected.length,
            matched: selected.filter(transitionMatches).length,
            accuracy: selected.length ? selected.filter(transitionMatches).length / selected.length : 0
          }
        ];
      })
    ) as Record<WorkflowState | "TERMINAL", unknown>
  };

  await mkdir(path.resolve("artifacts", "reports"), { recursive: true });
  const filename = `transitions_${Date.now()}.json`;
  await writeFile(path.resolve("artifacts", "reports", filename), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report=artifacts/reports/${filename}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
