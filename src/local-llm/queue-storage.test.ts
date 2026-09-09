import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listJobFiles,
  moveJob,
  queueDirectory,
  readJob,
  pendingQueueLimit,
  tryClaimJob,
  writeJob
} from "./queue.js";
import type { LocalLlmQueueJob } from "./types.js";

function fixtureJob(status: LocalLlmQueueJob["status"] = "pending"): LocalLlmQueueJob {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    id: `storage-${status}`,
    batchId: "storage-test",
    createdAt: now,
    updatedAt: now,
    status,
    attempts: 0,
    requiresVision: false,
    requestedModel: null,
    blockedReason: null,
    evidence: {
      sampleId: "sample-storage",
      goal: "verify queue writes expose complete JSON states only",
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
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-runtime-queue-storage-"));
  const previousRoot = process.env.WORKFLOWLENS_LLM_QUEUE_ROOT;
  const previousLimit = process.env.WORKFLOWLENS_LLM_QUEUE_MAX_PENDING;
  process.env.WORKFLOWLENS_LLM_QUEUE_ROOT = root;

  try {
    const job = fixtureJob();
    const filename = path.basename(await writeJob(job));
    assert.deepEqual(await listJobFiles("pending"), [filename]);
    assert.equal((await readJob(filename, "pending")).id, job.id);

    await writeFile(path.join(queueDirectory("pending"), `${filename}.partial.tmp`), "{broken");
    assert.deepEqual(await listJobFiles("pending"), [filename], "temporary partial writes are not queue jobs");

    const moved = await moveJob(filename, "pending", "blocked", (candidate) => ({
      ...candidate,
      status: "blocked",
      blockedReason: "storage regression"
    }));
    assert.equal(moved.job.status, "blocked");
    assert.deepEqual(await listJobFiles("pending"), []);
    assert.deepEqual(await listJobFiles("blocked"), [filename]);

    const claimed = await tryClaimJob(filename, "blocked");
    assert.ok(claimed);
    assert.equal(claimed.job.status, "running");
    assert.equal(claimed.job.attempts, 1);
    assert.deepEqual(await listJobFiles("running"), [filename]);

    process.env.WORKFLOWLENS_LLM_QUEUE_MAX_PENDING = "1";
    assert.equal(pendingQueueLimit(), 1);
    await writeJob({ ...fixtureJob("pending"), id: "bounded-1" });
    await assert.rejects(
      () => writeJob({ ...fixtureJob("pending"), id: "bounded-2" }),
      /Pending local LLM queue is full/,
      "optional queue bound rejects producer bursts before unbounded heap growth"
    );
    console.log("queue atomic storage test passed");
  } finally {
    if (previousRoot === undefined) delete process.env.WORKFLOWLENS_LLM_QUEUE_ROOT;
    else process.env.WORKFLOWLENS_LLM_QUEUE_ROOT = previousRoot;
    if (previousLimit === undefined) delete process.env.WORKFLOWLENS_LLM_QUEUE_MAX_PENDING;
    else process.env.WORKFLOWLENS_LLM_QUEUE_MAX_PENDING = previousLimit;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
