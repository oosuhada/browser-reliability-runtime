import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeWorkflowUrl } from "../browser/capture.js";

const BASE_URL = process.env.WORKFLOWLENS_BASE_URL ?? "http://127.0.0.1:4317";

interface GroundingTask {
  mutation: string;
  targetId: string;
  instruction: string;
}

const TASKS: GroundingTask[] = [
  { mutation: "none", targetId: "shipment_lookup_button", instruction: "Click the shipment lookup button" },
  { mutation: "none", targetId: "refund_button", instruction: "Click the refund order button" },
  { mutation: "element_moved", targetId: "refund_button", instruction: "Click the refund order button" },
  { mutation: "element_renamed", targetId: "shipment_lookup_button", instruction: "Click the shipment lookup button" },
  { mutation: "icon_only", targetId: "shipment_lookup_button", instruction: "Click the shipment lookup button" },
  { mutation: "offscreen_target", targetId: "refund_button", instruction: "Click the refund order button" },
  { mutation: "responsive_layout", targetId: "shipment_lookup_button", instruction: "Click the shipment lookup button" }
];

function center(bbox: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

async function main(): Promise<void> {
  const id = `grounding_${Date.now()}`;
  const outputDir = path.resolve("artifacts", "grounding", id);
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const samples = [];
  try {
    for (let index = 0; index < TASKS.length; index += 1) {
      const task = TASKS[index];
      const params = new URLSearchParams({ customer: "customer_a", mutation: task.mutation });
      await page.goto(`${BASE_URL}/orders/ORD-18401?${params.toString()}`);
      const locator = page.locator(`[data-target-id="${task.targetId}"]`).first();
      const bbox = await locator.boundingBox();
      const visible = await locator.isVisible().catch(() => false);
      if (!bbox || !visible) continue;
      const screenshot = `${String(index).padStart(2, "0")}_${task.mutation}_${task.targetId}.png`;
      await page.screenshot({ path: path.join(outputDir, screenshot), fullPage: true });
      samples.push({
        sample_id: `${id}_${index}`,
        screenshot: path.posix.join("artifacts", "grounding", id, screenshot),
        instruction: task.instruction,
        mutation: task.mutation,
        target_id: task.targetId,
        bbox,
        center: center(bbox),
        viewport: page.viewportSize(),
        page_url: sanitizeWorkflowUrl(page.url())
      });
    }
  } finally {
    await browser.close();
  }
  const datasetPath = path.join(outputDir, "grounding.jsonl");
  await writeFile(datasetPath, samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
  console.log(JSON.stringify({ samples: samples.length, dataset: datasetPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

