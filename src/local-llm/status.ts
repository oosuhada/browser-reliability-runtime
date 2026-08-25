import { isQueuePaused, listJobFiles, readJob } from "./queue.js";
import { isRemoteInferenceBusy, listRemoteModels } from "./remote.js";

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const paused = await isQueuePaused();
  const counts: Record<string, number> = {};
  const batches: Record<string, Record<string, number>> = {};
  for (const status of ["pending", "running", "blocked", "completed", "failed"] as const) {
    const files = await listJobFiles(status);
    counts[status] = files.length;
    for (const filename of files) {
      const job = await readJob(filename, status);
      batches[job.batchId] ??= { pending: 0, running: 0, blocked: 0, completed: 0, failed: 0 };
      batches[job.batchId][status] += 1;
    }
  }
  const blocked = [];
  for (const filename of (await listJobFiles("blocked")).slice(0, 10)) {
    const job = await readJob(filename, "blocked");
    blocked.push({ id: job.id, batchId: job.batchId, requiresVision: job.requiresVision, reason: job.blockedReason });
  }
  let remote: unknown = undefined;
  if (hasArg("remote")) {
    try {
      const busy = await isRemoteInferenceBusy();
      const models = await listRemoteModels();
      remote = {
        busy,
        loaded: models.filter((model) => model.state === "loaded"),
        availableVisionModels: models.filter((model) => model.type === "vlm").map((model) => model.id)
      };
    } catch (error) {
      remote = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  console.log(JSON.stringify({ paused, counts, batches, blocked, ...(remote === undefined ? {} : { remote }) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

