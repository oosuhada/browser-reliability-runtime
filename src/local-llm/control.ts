import { setQueuePaused } from "./queue.js";

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== "pause" && action !== "resume") {
    throw new Error("Usage: control.ts pause|resume");
  }
  await setQueuePaused(action === "pause");
  console.log(JSON.stringify({ paused: action === "pause" }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

