import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface ModelBenchmarkReport {
  schema?: string;
  benchmarkType?: string;
  batchId?: string | null;
  samples?: number;
  failureAccuracy?: number;
  failureMacroF1?: number;
  recoveryTop1Accuracy?: number;
  recoveryTop3Accuracy?: number;
  averageLatencyMs?: number;
  models?: string[];
  modalities?: string[];
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function percent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const inputs = (arg("inputs") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!inputs.length) {
    throw new Error("Provide comma-separated report files with --inputs=path1.json,path2.json");
  }

  const rows = [];
  for (const input of inputs) {
    const report = JSON.parse(await readFile(path.resolve(input), "utf8")) as ModelBenchmarkReport;
    rows.push({
      report: input,
      batchId: report.batchId ?? path.basename(input, path.extname(input)),
      model: report.models?.join(" + ") ?? "unknown",
      modalities: report.modalities?.join(" + ") ?? "unknown",
      samples: report.samples ?? 0,
      failureAccuracy: report.failureAccuracy,
      failureMacroF1: report.failureMacroF1,
      recoveryTop1Accuracy: report.recoveryTop1Accuracy,
      recoveryTop3Accuracy: report.recoveryTop3Accuracy,
      averageLatencyMs: report.averageLatencyMs
    });
  }

  const markdown = [
    "| Batch | Model | Modalities | N | Failure Acc | Macro-F1 | Recovery Top-1 | Recovery Top-3 | Avg latency |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.batchId} | ${row.model} | ${row.modalities} | ${row.samples} | ${percent(row.failureAccuracy)} | ${percent(row.failureMacroF1)} | ${percent(row.recoveryTop1Accuracy)} | ${percent(row.recoveryTop3Accuracy)} | ${row.averageLatencyMs === undefined ? "n/a" : `${row.averageLatencyMs} ms`} |`)
  ].join("\n");

  const report = {
    schema: "workflowlens.model-comparison.v1",
    generatedAt: new Date().toISOString(),
    rows
  };
  const reportDir = path.resolve("artifacts", "reports");
  await mkdir(reportDir, { recursive: true });
  const jsonOutput = arg("output") ?? path.join(reportDir, `model_comparison_${Date.now()}.json`);
  const markdownOutput = jsonOutput.replace(/\.json$/i, ".md");
  await writeFile(path.resolve(jsonOutput), JSON.stringify(report, null, 2));
  await writeFile(path.resolve(markdownOutput), `${markdown}\n`);
  console.log(markdown);
  console.log(`json=${jsonOutput}`);
  console.log(`markdown=${markdownOutput}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
