import { readFile } from "node:fs/promises";
import { bboxIoU, pointInsideTarget } from "./metrics.js";
import type { BoundingBox } from "../browser/types.js";

interface GroundTruthRow {
  sample_id: string;
  bbox: BoundingBox;
}

interface PredictionRow {
  sample_id: string;
  bbox?: BoundingBox;
  point?: { x: number; y: number };
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function readJsonl<T>(filename: string): Promise<T[]> {
  const text = await readFile(filename, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function main(): Promise<void> {
  const truthPath = arg("truth");
  const predictionPath = arg("predictions");
  if (!truthPath || !predictionPath) {
    throw new Error("Usage: npm run evaluate:grounding -- --truth=<grounding.jsonl> --predictions=<predictions.jsonl>");
  }
  const truth = await readJsonl<GroundTruthRow>(truthPath);
  const predictions = new Map((await readJsonl<PredictionRow>(predictionPath)).map((row) => [row.sample_id, row]));
  let iouSum = 0;
  let iouCount = 0;
  let pointHits = 0;
  let pointCount = 0;
  let localized = 0;

  for (const row of truth) {
    const prediction = predictions.get(row.sample_id);
    if (!prediction) continue;
    localized += 1;
    if (prediction.bbox) {
      iouSum += bboxIoU(row.bbox, prediction.bbox);
      iouCount += 1;
      const point = {
        x: prediction.bbox.x + prediction.bbox.width / 2,
        y: prediction.bbox.y + prediction.bbox.height / 2
      };
      pointHits += pointInsideTarget(point, row.bbox) ? 1 : 0;
      pointCount += 1;
    } else if (prediction.point) {
      pointHits += pointInsideTarget(prediction.point, row.bbox) ? 1 : 0;
      pointCount += 1;
    }
  }

  console.log(JSON.stringify({
    samples: truth.length,
    localizationCoverage: truth.length ? localized / truth.length : 0,
    meanIoU: iouCount ? iouSum / iouCount : null,
    pointInsideAccuracy: pointCount ? pointHits / pointCount : null
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

