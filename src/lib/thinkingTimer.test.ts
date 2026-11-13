import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLiveThinkingSeconds, computeFinalThoughtSeconds } from "./thinkingTimer";

describe("Buzz AI real-time thinking stopwatch", () => {
  it("starts at 0s and increments at exact 1,000ms boundaries so every second lasts 1 real second", () => {
    const start = 100000;
    // 0.00s - 0.999s -> 0s (duration: 1.000s)
    assert.equal(computeLiveThinkingSeconds(start, start + 0), 0);
    assert.equal(computeLiveThinkingSeconds(start, start + 500), 0);
    assert.equal(computeLiveThinkingSeconds(start, start + 999), 0);

    // 1.000s - 1.999s -> 1s (duration: 1.000s)
    assert.equal(computeLiveThinkingSeconds(start, start + 1000), 1);
    assert.equal(computeLiveThinkingSeconds(start, start + 1500), 1);
    assert.equal(computeLiveThinkingSeconds(start, start + 1999), 1);

    // 2.000s - 2.999s -> 2s (duration: 1.000s)
    assert.equal(computeLiveThinkingSeconds(start, start + 2000), 2);
    assert.equal(computeLiveThinkingSeconds(start, start + 2999), 2);

    // 3.000s -> 3s
    assert.equal(computeLiveThinkingSeconds(start, start + 3000), 3);
  });

  it("computes final completed thought duration rounded to nearest real second (min 1s)", () => {
    const start = 200000;
    assert.equal(computeFinalThoughtSeconds(start, start + 350), 1);
    assert.equal(computeFinalThoughtSeconds(start, start + 1200), 1);
    assert.equal(computeFinalThoughtSeconds(start, start + 1600), 2);
    assert.equal(computeFinalThoughtSeconds(start, start + 2400), 2);
    assert.equal(computeFinalThoughtSeconds(start, start + 2600), 3);
  });
});
