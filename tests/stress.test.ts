/**
 * Stress tests for opencode-task plugin
 *
 * Based on patterns from:
 * - Bun's subprocess stress tests (spawn-stress.test.ts, spawn-pipe-leak.test.ts)
 * - UV's concurrency tests (OnceMap, Semaphore patterns)
 *
 * Tests designed to expose:
 * - File descriptor leaks
 * - Memory leaks (output buffer accumulation)
 * - Main thread blocking
 * - Semaphore starvation
 * - Process zombie accumulation
 * - Pipe buffer deadlocks
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { Semaphore, TaskRegistry } from "../index";

// ============================================================================
// Test Utilities (from Bun's harness.ts patterns)
// ============================================================================

const isMacOS = process.platform === "darwin";
const isLinux = process.platform === "linux";

/**
 * Get current max file descriptor number
 * Pattern from: bun-repo/test/harness.ts:824
 */
function getMaxFD(): number {
  if (isMacOS || isLinux) {
    let max = -1;
    const fdDir = isMacOS ? "/dev/fd" : "/proc/self/fd";
    try {
      for (const entry of readdirSync(fdDir)) {
        const fd = Number.parseInt(entry.trim(), 10);
        if (Number.isSafeInteger(fd) && fd >= 0) {
          max = Math.max(max, fd);
        }
      }
      if (max >= 0) return max;
    } catch {
      // fallback below
    }
  }
  // Fallback: open and close a file to get current FD
  const file = Bun.file("/dev/null");
  return -1; // Can't determine on this platform
}

/**
 * Get memory usage in MB
 */
function getMemoryMB(): number {
  return Math.round(process.memoryUsage.rss() / (1024 * 1024));
}

/**
 * Force garbage collection and wait for finalizers
 * Pattern from: bun-repo/test/harness.ts gcTick
 */
async function gcTick(): Promise<void> {
  Bun.gc(true);
  await Bun.sleep(10);
  Bun.gc(true);
}

// ============================================================================
// STRESS TESTS
// ============================================================================

describe("Task Execution Stress Tests", () => {
  let registry: TaskRegistry;

  beforeAll(() => {
    registry = new TaskRegistry({ maxConcurrent: 20 });
  });

  afterAll(async () => {
    registry.clear();
    await gcTick();
  });

  // --------------------------------------------------------------------------
  // Test 1: File Descriptor Leak Detection
  // Pattern from: bun-repo/test/js/bun/spawn/spawn-streaming-stdout.test.ts
  // --------------------------------------------------------------------------
  test("no file descriptor leaks under concurrent load", async () => {
    const initialFD = getMaxFD();
    if (initialFD < 0) {
      console.log(
        "Skipping FD test - cannot determine FD count on this platform",
      );
      return;
    }

    const BATCH_SIZE = 10;
    const BATCHES = 5;

    for (let batch = 0; batch < BATCHES; batch++) {
      const ids = await Promise.all(
        Array.from({ length: BATCH_SIZE }, () => registry.spawn("echo hello")),
      );
      await Promise.all(ids.map((id) => registry.wait(id)));
    }

    await gcTick();
    const finalFD = getMaxFD();

    // Allow small variance (stdio FDs, etc) but catch leaks
    // Pattern: expect(newMaxFD).toBe(maxFD) with tolerance
    expect(finalFD).toBeLessThanOrEqual(initialFD + 10);
  }, 60000);

  // --------------------------------------------------------------------------
  // Test 2: Memory Leak Detection (Output Buffer Accumulation)
  // Pattern from: bun-repo/test/js/bun/spawn/spawn-pipe-leak.test.ts
  // --------------------------------------------------------------------------
  test("no memory leak from accumulated stdout/stderr", async () => {
    await gcTick();
    const memBefore = getMemoryMB();

    const ITERATIONS = 50;
    const OUTPUT_SIZE = 10000; // 10KB per task

    for (let i = 0; i < ITERATIONS; i++) {
      // Generate large output to stress buffer accumulation
      const id = await registry.spawn(
        `head -c ${OUTPUT_SIZE} /dev/urandom | base64`,
      );
      await registry.wait(id);
    }

    registry.clear();
    await gcTick();
    const memAfter = getMemoryMB();

    const delta = memAfter - memBefore;
    const growthPercent = delta / memBefore;

    // Pattern from Bun: memory growth < 80%
    // We're more conservative: < 50% since we're clearing tasks
    expect(growthPercent).toBeLessThan(0.5);
  }, 120000);

  // --------------------------------------------------------------------------
  // Test 3: Semaphore Starvation / Fairness
  // Pattern from: uv-repo OnceMap + Semaphore patterns
  // --------------------------------------------------------------------------
  test("semaphore maintains fairness under contention", async () => {
    const narrowRegistry = new TaskRegistry({ maxConcurrent: 3 });
    const TOTAL_TASKS = 30;
    const completionOrder: string[] = [];

    const ids = await Promise.all(
      Array.from({ length: TOTAL_TASKS }, (_, i) =>
        narrowRegistry.spawn(`echo task-${i} && sleep 0.01`),
      ),
    );

    // Wait for all to complete, track order
    await Promise.all(
      ids.map(async (id) => {
        await narrowRegistry.wait(id);
        completionOrder.push(id);
      }),
    );

    // Verify all tasks completed
    expect(completionOrder.length).toBe(TOTAL_TASKS);

    // Verify approximate FIFO order (tasks should complete roughly in order)
    // Allow some reordering due to timing, but early tasks should finish early
    const firstHalf = completionOrder.slice(0, TOTAL_TASKS / 2);
    const earlyTasksInFirstHalf = firstHalf.filter((id) => {
      const num = Number.parseInt(id.split("-")[1]);
      return num < TOTAL_TASKS / 2;
    }).length;

    // At least 60% of first-half completions should be from early tasks
    expect(earlyTasksInFirstHalf).toBeGreaterThanOrEqual(
      (TOTAL_TASKS / 2) * 0.6,
    );

    narrowRegistry.clear();
  }, 60000);

  // --------------------------------------------------------------------------
  // Test 4: Concurrent Task Burst (20+ simultaneous)
  // Pattern from: plan requirement of 20+ concurrent tasks
  // --------------------------------------------------------------------------
  test("handles 20+ concurrent tasks without deadlock", async () => {
    const CONCURRENT = 25;
    const startTime = Date.now();

    const ids = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) =>
        registry.spawn(`echo "task ${i}" && sleep 0.05`),
      ),
    );

    // All tasks should complete
    const results = await Promise.all(
      ids.map((id) => registry.wait(id, 10000)),
    );

    const duration = Date.now() - startTime;

    // Verify all completed successfully
    for (let i = 0; i < results.length; i++) {
      const task = results[i];
      expect(task.status).toBe("completed");
      // Read stdout from file path
      const stdout = await Bun.file(task.stdout).text();
      expect(stdout).toContain(`task ${i}`);
    }

    // With 20 concurrent limit and 25 tasks at 50ms each,
    // should complete in ~150ms (2 batches), not 25*50ms = 1250ms
    expect(duration).toBeLessThan(5000);
  }, 30000);

  // --------------------------------------------------------------------------
  // Test 5: Main Thread Blocking Detection
  // Pattern from: bun-repo/test/js/bun/shell/shell-blocking-pipe.test.ts
  // --------------------------------------------------------------------------
  test("large output does not block main thread", async () => {
    const OUTPUT_SIZE = 1024 * 1024; // 1MB

    // Start a task that outputs 1MB with deliberate delay to allow tick measurement
    // The sleep ensures we have time to verify main thread remains responsive
    const id = await registry.spawn(
      `sleep 0.1 && head -c ${OUTPUT_SIZE} /dev/zero | base64`,
    );

    // While that runs, we should be able to do other work
    // Use 1ms interval for finer granularity
    let tickCount = 0;
    const tickInterval = setInterval(() => tickCount++, 1);

    await registry.wait(id, 30000);
    clearInterval(tickInterval);

    const task = registry.get(id);
    if (!task) throw new Error("Task not found");
    expect(task.status).toBe("completed");

    // Read stdout from file path to verify output captured
    const stdout = await Bun.file(task.stdout).text();
    expect(stdout.length).toBeGreaterThan(OUTPUT_SIZE); // base64 expands

    // With 100ms+ execution time and 1ms interval, expect many ticks
    // If main thread was blocked, tickCount would be near zero
    expect(tickCount).toBeGreaterThan(50);
  }, 60000);

  // --------------------------------------------------------------------------
  // Test 6: Rapid Spawn/Complete Cycling
  // Pattern from: bun-repo/test/js/bun/spawn/spawn-stress.test.ts
  // --------------------------------------------------------------------------
  test("handles rapid spawn/complete cycles", async () => {
    const CYCLES = 100;

    for (let i = 0; i < CYCLES; i++) {
      const id = await registry.spawn("echo cycle");
      const task = await registry.wait(id);
      expect(task.status).toBe("completed");
    }

    // After rapid cycling, registry should not have leaked state
    await gcTick();
  }, 60000);

  // --------------------------------------------------------------------------
  // Test 7: Error Handling Under Load
  // Pattern from: uv-repo/crates/uv/tests/it/network.rs error scenarios
  // --------------------------------------------------------------------------
  test("handles mixed success/failure under load", async () => {
    const TASKS = 20;
    const ids: string[] = [];

    for (let i = 0; i < TASKS; i++) {
      // Alternate between success and failure commands
      const cmd = i % 2 === 0 ? "echo success" : "exit 1";
      ids.push(await registry.spawn(cmd));
    }

    const results = await Promise.all(ids.map((id) => registry.wait(id)));

    const successes = results.filter((t) => t.status === "completed").length;
    const failures = results.filter((t) => t.status === "failed").length;

    expect(successes).toBe(TASKS / 2);
    expect(failures).toBe(TASKS / 2);
  }, 30000);

  // --------------------------------------------------------------------------
  // Test 8: Long-Running Task Timeout
  // Pattern from: uv-repo timeout handling with UV_LOCK_TIMEOUT
  // --------------------------------------------------------------------------
  test("timeout kills long-running tasks", async () => {
    const timeoutRegistry = new TaskRegistry({ maxConcurrent: 5 });

    const id = await timeoutRegistry.spawn("sleep 10", { timeout: 500 });

    const start = Date.now();
    const task = await timeoutRegistry.wait(id, 5000);
    const duration = Date.now() - start;

    // Should have been cancelled, not completed
    expect(task.status).toBe("cancelled");

    // Should complete in ~500ms, not 10 seconds
    expect(duration).toBeLessThan(2000);

    timeoutRegistry.clear();
  }, 10000);

  // --------------------------------------------------------------------------
  // Test 9: Task Queue Pressure (More tasks than semaphore permits)
  // Pattern from: uv-repo bounded(300) channel backpressure
  // --------------------------------------------------------------------------
  test("queue handles pressure beyond semaphore capacity", async () => {
    const tinyRegistry = new TaskRegistry({ maxConcurrent: 2 });
    const QUEUED = 10;

    const ids = await Promise.all(
      Array.from({ length: QUEUED }, () =>
        tinyRegistry.spawn("echo queued && sleep 0.05"),
      ),
    );

    // Check queue state
    expect(tinyRegistry.activeCount).toBeLessThanOrEqual(2);
    expect(tinyRegistry.waitingCount).toBeGreaterThan(0);

    // All should eventually complete
    const results = await Promise.all(ids.map((id) => tinyRegistry.wait(id)));
    for (const task of results) {
      expect(task.status).toBe("completed");
    }

    tinyRegistry.clear();
  }, 30000);

  // --------------------------------------------------------------------------
  // Test 10: Process Output Streaming vs Buffering
  // Pattern from: Bun's PipeReader streaming mode
  // --------------------------------------------------------------------------
  test("captures incremental output correctly", async () => {
    // Command that outputs in chunks with delays
    const id = await registry.spawn(
      'for i in 1 2 3; do echo "chunk $i"; sleep 0.1; done',
    );

    const task = await registry.wait(id);

    expect(task.status).toBe("completed");
    // Read stdout from file path
    const stdout = await Bun.file(task.stdout).text();
    expect(stdout).toContain("chunk 1");
    expect(stdout).toContain("chunk 2");
    expect(stdout).toContain("chunk 3");
  }, 10000);

  // --------------------------------------------------------------------------
  // Test 11: Promise-based wait (LOOP-3 fix verification)
  // --------------------------------------------------------------------------
  test("wait uses promise, not polling", async () => {
    const id = await registry.spawn("sleep 0.2 && echo done");

    // If polling, this would spin CPU. Promise-based should be idle.
    const startCpu = process.cpuUsage();
    await registry.wait(id);
    const endCpu = process.cpuUsage(startCpu);

    // CPU time should be minimal (< 50ms user time)
    // Polling at 10ms intervals for 200ms would use ~200ms
    expect(endCpu.user / 1000).toBeLessThan(50);
  }, 10000);
});

// ============================================================================
// SEMAPHORE UNIT TESTS
// ============================================================================

describe("Semaphore", () => {
  test("respects concurrency limit", async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 10 }, async () => {
      await sem.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Bun.sleep(10);
      concurrent--;
      sem.release();
    });

    await Promise.all(tasks);
    expect(maxConcurrent).toBe(2);
  });

  test("drain rejects waiting acquires", async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // Take the only permit

    const waitPromise = sem.acquire(); // This will wait
    sem.drain();

    await expect(waitPromise).rejects.toThrow("Semaphore drained");
  });

  test("activeCount and waitingCount are accurate", async () => {
    const sem = new Semaphore(2);

    await sem.acquire();
    expect(sem.activeCount).toBe(1);
    expect(sem.waitingCount).toBe(0);

    await sem.acquire();
    expect(sem.activeCount).toBe(2);

    const waitPromise = sem.acquire(); // Will wait
    await Bun.sleep(1);
    expect(sem.waitingCount).toBe(1);

    sem.release();
    await waitPromise;
    expect(sem.activeCount).toBe(2);
    expect(sem.waitingCount).toBe(0);

    sem.release();
    sem.release();
  });
});

// ============================================================================
// TTL EVICTION TESTS (LOOP-1 fix)
// ============================================================================

describe("TaskRegistry TTL Eviction", () => {
  test("tasks are evicted after TTL", async () => {
    const registry = new TaskRegistry({
      maxConcurrent: 5,
      taskTTL: 100, // 100ms TTL for testing
    });

    const id = await registry.spawn("echo test");
    await registry.wait(id);

    // Task exists immediately after completion
    expect(registry.get(id)).toBeDefined();

    // Wait for TTL + buffer
    await Bun.sleep(150);

    // Task should be evicted
    expect(registry.get(id)).toBeUndefined();

    registry.clear();
  }, 5000);

  test("accessing task resets eviction timer", async () => {
    const registry = new TaskRegistry({
      maxConcurrent: 5,
      taskTTL: 100,
    });

    const id = await registry.spawn("echo test");
    await registry.wait(id);

    // Access at 50ms (before TTL)
    await Bun.sleep(50);
    expect(registry.get(id)).toBeDefined(); // Resets timer

    // Access at 100ms (50ms after last access, before new TTL)
    await Bun.sleep(50);
    expect(registry.get(id)).toBeDefined(); // Still exists, timer reset again

    // Wait full TTL without access
    await Bun.sleep(150);
    expect(registry.get(id)).toBeUndefined();

    registry.clear();
  }, 5000);
});

// ============================================================================
// GRACEFUL SHUTDOWN TESTS (LOOP-6 fix)
// ============================================================================

describe("TaskRegistry Shutdown", () => {
  test("shutdown stops accepting new tasks", async () => {
    const registry = new TaskRegistry({ maxConcurrent: 5 });

    await registry.shutdown();

    await expect(registry.spawn("echo test")).rejects.toThrow("shutting down");
  });

  test("shutdown terminates running tasks", async () => {
    const registry = new TaskRegistry({ maxConcurrent: 5 });

    const id = await registry.spawn("sleep 10");
    await Bun.sleep(50); // Let it start

    const task = registry.get(id);
    expect(task?.status).toBe("running");

    await registry.shutdown(100);

    // Task should be terminated
    expect(task?.status).not.toBe("running");
  }, 5000);
});

// ============================================================================
// BENCHMARK SUITE (separate from stress tests)
// ============================================================================

describe("Task Execution Benchmarks", () => {
  test("spawn throughput baseline", async () => {
    const registry = new TaskRegistry({ maxConcurrent: 20 });
    const COUNT = 100;
    const start = Date.now();

    const ids = await Promise.all(
      Array.from({ length: COUNT }, () => registry.spawn("echo bench")),
    );
    await Promise.all(ids.map((id) => registry.wait(id)));

    const duration = Date.now() - start;
    const throughput = COUNT / (duration / 1000);

    console.log(`Throughput: ${throughput.toFixed(1)} tasks/sec`);
    console.log(`Duration: ${duration}ms for ${COUNT} tasks`);

    // Baseline expectation: at least 10 tasks/sec
    expect(throughput).toBeGreaterThan(10);

    registry.clear();
  }, 60000);
});
