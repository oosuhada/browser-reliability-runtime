import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { classificationMetrics } from "../evaluation/metrics.js";
import { listJobFiles, queueDirectory } from "./queue.js";
import type { LocalLlmCompletedJob } from "./types.js";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main(): Promise<void> {
  const batchId = arg("batch");
  const rows: LocalLlmCompletedJob[] = [];
  for (const filename of await listJobFiles("completed")) {
    const job = JSON.parse(await readFile(path.join(queueDirectory("completed"), filename), "utf8")) as LocalLlmCompletedJob;
    if (!batchId || job.batchId === batchId) rows.push(job);
  }
  const expectedFailures = rows.map((job) => job.expected.failureType);
  const predictedFailures = rows.map((job) => job.result.prediction.failure_type);
  const classification = classificationMetrics(expectedFailures, predictedFailures);
  const recoveryCorrect = rows.filter((job) => job.expected.recovery === job.result.prediction.recovery).length;
  const recoveryTop3Correct = rows.filter((job) => {
    const ranking = job.result.prediction.recovery_ranking?.length
      ? job.result.prediction.recovery_ranking
      : [job.result.prediction.recovery];
    return ranking.slice(0, 3).includes(job.expected.recovery);
  }).length;
  const averageLatencyMs = rows.length
    ? Math.round(rows.reduce((sum, job) => sum + job.result.latencyMs, 0) / rows.length)
    : 0;
  const report = {
    schema: "workflowlens.model-benchmark.v1",
    benchmarkType: "local_llm",
    batchId,
    samples: rows.length,
    failureAccuracy: classification.accuracy,
    failureMacroF1: classification.macroF1,
    recoveryTop1Accuracy: rows.length ? recoveryCorrect / rows.length : 0,
    recoveryTop3Accuracy: rows.length ? recoveryTop3Correct / rows.length : 0,
    averageLatencyMs,
    models: [...new Set(rows.map((job) => job.result.model))],
    modalities: [...new Set(rows.map((job) => job.requiresVision ? "vision+structured" : "structured-text"))],
    byClass: classification.byClass,
    confusion: classification.confusion
  };
  const reportDir = path.resolve("artifacts", "reports");
  await mkdir(reportDir, { recursive: true });
  const safeBatch = (batchId ?? "all").replace(/[^a-zA-Z0-9_-]/g, "_");
  const output = arg("output") ?? path.join(reportDir, `local_llm_${safeBatch}_${Date.now()}.json`);
  await writeFile(path.resolve(output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, report: output }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

