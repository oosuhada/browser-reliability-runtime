import type { LocalLlmQueueJob } from "./types.js";

export function retryDelayMs(attempts: number, baseMs = 1_000, maxMs = 60_000): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(maxMs, baseMs * (2 ** Math.min(exponent, 20)));
}

export function retryAt(job: Pick<LocalLlmQueueJob, "attempts">, nowMs = Date.now()): string {
  const configuredBase = Number(process.env.WORKFLOWLENS_LLM_RETRY_BASE_MS ?? 1_000);
  const base = Number.isFinite(configuredBase) && configuredBase > 0 ? configuredBase : 1_000;
  return new Date(nowMs + retryDelayMs(job.attempts, base)).toISOString();
}

export function isRetryReady(job: Pick<LocalLlmQueueJob, "nextAttemptAt">, nowMs = Date.now()): boolean {
  if (!job.nextAttemptAt) return true;
  const scheduled = Date.parse(job.nextAttemptAt);
  return Number.isNaN(scheduled) || scheduled <= nowMs;
}
