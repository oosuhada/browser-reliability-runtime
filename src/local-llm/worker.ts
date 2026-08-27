import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureQueueDirectories, isQueuePaused, listJobFiles, moveJob, queueDirectory, readJob, recoverStaleRunning } from "./queue.js";
import { resolveLoadedModel, runRemoteDiagnosis } from "./remote.js";
import type { LocalLlmCompletedJob, LocalLlmQueueJob, LocalLlmQueueStatus } from "./types.js";

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idlePollMs(): number {
  return Number(process.env.WORKFLOWLENS_LLM_IDLE_POLL_MS ?? 30_000);
}

async function candidate(): Promise<{ filename: string; status: "pending" | "blocked" } | null> {
  const pending = await listJobFiles("pending");
  if (pending[0]) return { filename: pending[0], status: "pending" };
  const blocked = await listJobFiles("blocked");
  if (blocked[0]) return { filename: blocked[0], status: "blocked" };
  return null;
}

async function saveRunningJob(filename: string, job: LocalLlmQueueJob): Promise<void> {
  await writeFile(path.join(queueDirectory("running"), filename), JSON.stringify(job, null, 2));
}

async function processOne(): Promise<boolean> {
  const next = await candidate();
  if (!next) return false;
  const sourceJob = await readJob(next.filename, next.status);
  let model;
  try {
    model = await resolveLoadedModel(sourceJob.requiresVision, sourceJob.requestedModel);
  } catch (error) {
    const reason = `Remote LM Studio is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    if (next.status === "pending") {
      await moveJob(next.filename, "pending", "blocked", (job) => ({
        ...job,
        status: "blocked",
        updatedAt: new Date().toISOString(),
        blockedReason: reason
      }));
      console.log(`BLOCKED ${sourceJob.id}: ${reason}`);
      return true;
    }
    return false;
  }

  if (await isQueuePaused()) {
    return false;
  }

  if (!model) {
    const reason = sourceJob.requiresVision
      ? `No compatible VLM is currently loaded on ${process.env.WORKFLOWLENS_LLM_SSH_HOST ?? "macbook-pro"}. Job remains blocked.`
      : `Requested model is not currently loaded on ${process.env.WORKFLOWLENS_LLM_SSH_HOST ?? "macbook-pro"}. Job remains blocked.`;
    if (next.status === "pending") {
      await moveJob(next.filename, "pending", "blocked", (job) => ({
        ...job,
        status: "blocked",
        updatedAt: new Date().toISOString(),
        blockedReason: reason
      }));
      console.log(`BLOCKED ${sourceJob.id}: ${reason}`);
    }
    return next.status === "pending";
  }

  const claimed = await moveJob(next.filename, next.status, "running", (job) => ({
    ...job,
    status: "running",
    updatedAt: new Date().toISOString(),
    blockedReason: null,
    attempts: job.attempts + 1
  }));
  const job = claimed.job;
  try {
    let screenshotBase64: string | null = null;
    if (job.requiresVision) {
      if (!job.evidence.screenshotPath) throw new Error("Vision job is missing screenshotPath.");
      screenshotBase64 = (await readFile(path.resolve(job.evidence.screenshotPath))).toString("base64");
    }
    const result = await runRemoteDiagnosis(model, job.evidence, job.requiresVision, screenshotBase64);
    const completed: LocalLlmCompletedJob = {
      ...job,
      status: "completed",
      updatedAt: new Date().toISOString(),
      result: {
        model: model.id,
        latencyMs: result.latencyMs,
        prediction: result.prediction,
        rawContent: result.rawContent
      }
    };
    await saveRunningJob(next.filename, completed);
    await moveJob(next.filename, "running", "completed", () => completed);
    console.log(`COMPLETED ${job.id} model=${model.id} latency=${result.latencyMs}ms failure=${result.prediction.failure_type} recovery=${result.prediction.recovery}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retry = job.attempts < Number(process.env.WORKFLOWLENS_LLM_MAX_ATTEMPTS ?? 2);
    const destination: LocalLlmQueueStatus = retry ? "pending" : "failed";
    await moveJob(next.filename, "running", destination, (running) => ({
      ...running,
      status: destination,
      updatedAt: new Date().toISOString(),
      blockedReason: message
    }));
    console.error(`${retry ? "RETRY" : "FAILED"} ${job.id}: ${message}`);
  }
  return true;
}

async function main(): Promise<void> {
  await ensureQueueDirectories();
  const recovered = await recoverStaleRunning();
  if (recovered) console.log(`Recovered ${recovered} stale running job(s).`);
  const watch = hasArg("watch");
  do {
    if (await isQueuePaused()) {
      if (!watch) break;
      await sleep(idlePollMs());
      continue;
    }
    const didWork = await processOne();
    if (!watch) break;
    await sleep(didWork ? 500 : idlePollMs());
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

