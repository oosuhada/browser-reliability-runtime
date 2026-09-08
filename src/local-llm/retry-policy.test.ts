import assert from "node:assert/strict";
import { isRetryReady, retryAt, retryDelayMs } from "./retry-policy.js";

assert.equal(retryDelayMs(1), 1_000);
assert.equal(retryDelayMs(2), 2_000);
assert.equal(retryDelayMs(3), 4_000);
assert.equal(retryDelayMs(20), 60_000, "retry delay is capped instead of growing without bound");

const now = Date.parse("2026-09-08T12:00:00.000Z");
assert.equal(
  retryAt({ attempts: 3 } as never, now),
  "2026-09-08T12:00:04.000Z",
  "third failed attempt schedules four-second retry with default base"
);
assert.equal(isRetryReady({ nextAttemptAt: "2026-09-08T11:59:59.000Z" }, now), true);
assert.equal(isRetryReady({ nextAttemptAt: "2026-09-08T12:00:01.000Z" }, now), false);
assert.equal(isRetryReady({ nextAttemptAt: null }, now), true);

console.log("retry backoff policy test passed");
