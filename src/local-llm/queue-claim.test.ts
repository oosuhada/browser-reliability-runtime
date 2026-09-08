import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listJobFiles, readJob, tryClaimJob, writeJob } from "./queue.js";
import type { LocalLlmQueueJob } from "./types.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-runtime-queue-claim-"));
  const previousRoot = process.env.WORKFLOWLENS_LLM_QUEUE_ROOT;
  process.env.WORKFLOWLENS_LLM_QUEUE_ROOT = root;

  try {
    const now = new Date().toISOString();
    const job: LocalLlmQueueJob = {
      schemaVersion: "1.0",
      id: "claim-race",
      batchId: "test",
      createdAt: now,
      updatedAt: now,
      status: "pending",
      attempts: 0,
      requiresVision: false,
      requestedModel: null,
      blockedReason: null,
      evidence: {
        sampleId: "sample-1",
        goal: "verify atomic file-backed claim",
        previousState: null,
        previousAction: null,
        expectedNextState: null,
        currentState: "ready",
        domSnapshot: {},
        accessibilityTree: "",
        actionHistory: [],
        customerPolicy: {},
        screenshotPath: null
      },
      expected: {
        failureType: "UNKNOWN_STATE",
        recovery: "ABORT"
      }
    };

    const filename = path.basename(await writeJob(job));
    const claims = await Promise.all([
      tryClaimJob(filename, "pending"),
      tryClaimJob(filename, "pending")
    ]);

    assert.equal(claims.filter(Boolean).length, 1, "exactly one concurrent worker should win the claim");
    assert.deepEqual(await listJobFiles("pending"), []);
    assert.deepEqual(await listJobFiles("running"), [filename]);
    const running = await readJob(filename, "running");
    assert.equal(running.status, "running");
    assert.equal(running.attempts, 1, "claim increments attempts once, not once per contender");
    console.log("queue claim race test passed");
  } finally {
    if (previousRoot === undefined) delete process.env.WORKFLOWLENS_LLM_QUEUE_ROOT;
    else process.env.WORKFLOWLENS_LLM_QUEUE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
