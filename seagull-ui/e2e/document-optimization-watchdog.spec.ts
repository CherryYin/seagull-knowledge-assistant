import { expect, test } from "@playwright/test";
import { DocumentOptimizationWatchdog } from "../src/lib/document-optimization-watchdog";

const minute = 60_000;

test("ongoing model activity survives five minutes but cannot extend the active deadline", () => {
  const watchdog = new DocumentOptimizationWatchdog(12000, 0);
  watchdog.activity(4 * minute);
  expect(watchdog.status(6 * minute).timeout).toBeNull();
  watchdog.activity(9 * minute);
  expect(watchdog.status(10 * minute).timeout).toBe("deadline");
});

test("missing model activity stops at five minutes regardless of the larger document budget", () => {
  const watchdog = new DocumentOptimizationWatchdog(80000, 0);
  expect(watchdog.status(5 * minute - 1).timeout).toBeNull();
  expect(watchdog.status(5 * minute).timeout).toBe("idle");
});

test("long input gets a bounded larger budget without changing its contents", () => {
  expect(new DocumentOptimizationWatchdog(1000, 0).activeLimitMs).toBe(10 * minute);
  expect(new DocumentOptimizationWatchdog(40000, 0).activeLimitMs).toBe(15 * minute);
  expect(new DocumentOptimizationWatchdog(1000000, 0).activeLimitMs).toBe(20 * minute);
});

test("time waiting for user clarification does not consume the run budget", () => {
  const watchdog = new DocumentOptimizationWatchdog(1000, 0);
  watchdog.waitForAnswer(true, 4 * minute);
  expect(watchdog.status(40 * minute).timeout).toBeNull();
  watchdog.waitForAnswer(false, 44 * minute);
  expect(watchdog.status(48 * minute)).toMatchObject({ elapsedSeconds: 480, idleSeconds: 240, timeout: null });
  expect(watchdog.status(49 * minute).timeout).toBe("idle");
});
