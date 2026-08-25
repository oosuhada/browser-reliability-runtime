import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalLlmQueueJob, LocalLlmQueueStatus } from "./types.js";

export const QUEUE_STATUSES: LocalLlmQueueStatus[] = ["pending", "running", "blocked", "completed", "failed"];

export function queueRoot(): string {
  return path.resolve(process.env.WORKFLOWLENS_LLM_QUEUE_ROOT ?? path.join("artifacts", "local-llm-queue"));
}

export function queueDirectory(status: LocalLlmQueueStatus): string {
  return path.join(queueRoot(), status);
}

export function pauseFile(): string {
  return path.join(queueRoot(), "PAUSED");
}

export async function isQueuePaused(): Promise<boolean> {
  try {
    await access(pauseFile());
    return true;
  } catch {
    return false;
  }
}

export async function setQueuePaused(paused: boolean): Promise<void> {
  await ensureQueueDirectories();
  if (paused) {
    await writeFile(pauseFile(), `${new Date().toISOString()}\n`);
  } else {
    await rm(pauseFile(), { force: true });
  }
}

export async function ensureQueueDirectories(): Promise<void> {
  await Promise.all(QUEUE_STATUSES.map((status) => mkdir(queueDirectory(status), { recursive: true })));
}

export function jobFilename(job: Pick<LocalLlmQueueJob, "createdAt" | "id">): string {
  const stamp = job.createdAt.replace(/[^0-9]/g, "").slice(0, 17);
  return `${stamp}_${job.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
}

export async function writeJob(job: LocalLlmQueueJob, filename = jobFilename(job)): Promise<string> {
  await ensureQueueDirectories();
  const target = path.join(queueDirectory(job.status), filename);
  await writeFile(target, JSON.stringify(job, null, 2));
  return target;
}

export async function readJob(filename: string, status: LocalLlmQueueStatus): Promise<LocalLlmQueueJob> {
  return JSON.parse(await readFile(path.join(queueDirectory(status), filename), "utf8")) as LocalLlmQueueJob;
}

export async function listJobFiles(status: LocalLlmQueueStatus): Promise<string[]> {
  await ensureQueueDirectories();
  return (await readdir(queueDirectory(status)))
    .filter((filename) => filename.endsWith(".json"))
    .sort();
}

export async function moveJob(
  filename: string,
  from: LocalLlmQueueStatus,
  to: LocalLlmQueueStatus,
  update: (job: LocalLlmQueueJob) => LocalLlmQueueJob
): Promise<{ filename: string; job: LocalLlmQueueJob }> {
  const source = path.join(queueDirectory(from), filename);
  const target = path.join(queueDirectory(to), filename);
  const job = update(await readJob(filename, from));
  await writeFile(source, JSON.stringify(job, null, 2));
  await rename(source, target);
  return { filename, job };
}

export async function recoverStaleRunning(maxAgeMs = 30 * 60_000): Promise<number> {
  await ensureQueueDirectories();
  const now = Date.now();
  let recovered = 0;
  for (const filename of await listJobFiles("running")) {
    const filepath = path.join(queueDirectory("running"), filename);
    const fileStat = await stat(filepath);
    if (now - fileStat.mtimeMs < maxAgeMs) continue;
    await moveJob(filename, "running", "pending", (job) => ({
      ...job,
      status: "pending",
      updatedAt: new Date().toISOString(),
      blockedReason: "Recovered from stale running state after worker restart."
    }));
    recovered += 1;
  }
  return recovered;
}

