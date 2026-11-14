/**
 * Pure real-time stopwatch calculation for Buzz AI thinking indicator.
 * Ensures every second (0s, 1s, 2s, 3s...) lasts an authentic 1,000ms
 * without clamping 0.0s–1.99s into a 2-second-long "1s" display.
 */

export function computeLiveThinkingSeconds(startTimeMs: number, nowMs: number): number {
  if (!Number.isFinite(startTimeMs) || !Number.isFinite(nowMs)) return 0;
  const elapsedMs = Math.max(0, nowMs - startTimeMs);
  return Math.floor(elapsedMs / 1000);
}

export function computeFinalThoughtSeconds(startTimeMs: number, endTimeMs: number): number {
  if (!Number.isFinite(startTimeMs) || !Number.isFinite(endTimeMs)) return 1;
  const elapsedMs = Math.max(0, endTimeMs - startTimeMs);
  return Math.max(1, Math.round(elapsedMs / 1000));
}
