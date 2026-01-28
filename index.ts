import { appendFile } from "node:fs/promises";
import { type Plugin, tool } from "@opencode-ai/plugin";

// ============================================================================
// Semaphore - Concurrency limiter with FIFO fairness
// ============================================================================

export class Semaphore {
  private permits: number;
  private waiting: Array<{ resolve: () => void; reject: (e: Error) => void }> =
    [];
  private acquired = 0;
  private draining = false;

  constructor(public readonly maxConcurrent: number) {
    this.permits = maxConcurrent;
  }

  async acquire(): Promise<void> {
    if (this.draining) throw new Error("Semaphore is draining");
    if (this.permits > 0) {
      this.permits--;
      this.acquired++;
      return;
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  release(): void {
    // NOTE(victor): LOOP-4 fix - decrement acquired BEFORE awakening next waiter
    // Otherwise acquired count becomes inconsistent during handoff
    this.acquired--;
    const next = this.waiting.shift();
    if (next) {
      this.acquired++;
      next.resolve();
    } else {
      this.permits++;
    }
  }

  drain(): void {
    this.draining = true;
    for (const waiter of this.waiting) {
      waiter.reject(new Error("Semaphore drained"));
    }
    this.waiting = [];
  }

  get activeCount(): number {
    return this.acquired;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }
}

// ============================================================================
// Task Types and Factory
// ============================================================================

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  stdout: string; // File path (not content)
  stderr: string; // File path (not content)
  exitCode?: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  timeout?: number;
  abortController: AbortController;
  proc?: ReturnType<typeof Bun.spawn>;
  // NOTE(victor): LOOP-3 fix - Promise-based completion instead of polling
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
}

export function createTask(
  id: string,
  command: string,
  cwd: string,
  timeout?: number,
): Task {
  let resolveCompletion!: () => void;
  const completionPromise = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  return {
    id,
    command,
    cwd,
    status: "pending",
    stdout: `/tmp/${id}-stdout`,
    stderr: `/tmp/${id}-stderr`,
    createdAt: Date.now(),
    timeout,
    abortController: new AbortController(),
    completionPromise,
    resolveCompletion,
  };
}

// ============================================================================
// TaskRegistry - Orchestrates task lifecycle
// ============================================================================

export interface RegistryOptions {
  maxConcurrent?: number; // Default: 50
  taskTTL?: number; // Default: 30000ms
  maxOutputSize?: number; // Default: 5MB
}

export class TaskRegistry {
  private tasks = new Map<string, Task>();
  private semaphore: Semaphore;
  private nextId = 0;
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private accepting = true;
  private options: Required<RegistryOptions>;

  constructor(options: RegistryOptions = {}) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 50,
      taskTTL: options.taskTTL ?? 30000,
      maxOutputSize: options.maxOutputSize ?? 5 * 1024 * 1024,
    };
    this.semaphore = new Semaphore(this.options.maxConcurrent);
  }

  async spawn(
    command: string,
    options: { timeout?: number; cwd?: string } = {},
  ): Promise<string> {
    if (!this.accepting) {
      throw new Error("Registry is shutting down");
    }

    const id = `task-${this.nextId++}`;
    const cwd = options.cwd ?? process.cwd();
    const task = createTask(id, command, cwd, options.timeout);
    this.tasks.set(id, task);

    // Execute in background - don't await
    this.executeTask(task);
    return id;
  }

  private async executeTask(task: Task): Promise<void> {
    try {
      await this.semaphore.acquire();
    } catch (e) {
      task.status = "cancelled";
      task.error = String(e);
      task.resolveCompletion();
      return;
    }

    try {
      task.status = "running";
      task.startedAt = Date.now();

      const timeoutId = task.timeout
        ? setTimeout(() => task.abortController.abort(), task.timeout)
        : null;

      try {
        const proc = Bun.spawn(["sh", "-c", task.command], {
          cwd: task.cwd,
          stdout: Bun.file(task.stdout),
          stderr: Bun.file(task.stderr),
        });

        task.proc = proc;

        // Wire AbortSignal to terminate subprocess
        task.abortController.signal.addEventListener("abort", () => {
          proc.kill();
        });

        const exitCode = await proc.exited;

        task.exitCode = exitCode;
        if (task.abortController.signal.aborted) {
          task.status = "cancelled";
        } else {
          task.status = exitCode === 0 ? "completed" : "failed";
        }
      } catch (error) {
        const errorMsg = `\n[Task execution error: ${String(error)}]\n`;
        await appendFile(task.stderr, errorMsg);

        if (task.abortController.signal.aborted) {
          task.status = "cancelled";
        } else {
          task.status = "failed";
          task.error = String(error);
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        task.completedAt = Date.now();
      }
    } finally {
      this.semaphore.release();
      task.resolveCompletion();
      this.scheduleEviction(task.id);
    }
  }

  // NOTE(victor): LOOP-1 fix - TTL-based eviction to prevent memory leak
  private scheduleEviction(id: string): void {
    const existing = this.evictionTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.tasks.delete(id);
      this.evictionTimers.delete(id);
    }, this.options.taskTTL);

    this.evictionTimers.set(id, timer);
  }

  get(id: string): Task | undefined {
    // Reset eviction timer on access
    const task = this.tasks.get(id);
    if (task?.completedAt) {
      this.scheduleEviction(id);
    }
    return task;
  }

  // NOTE(victor): LOOP-3 fix - Promise-based wait, zero CPU polling
  async wait(id: string, timeoutMs = 30000): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);

    if (task.status !== "pending" && task.status !== "running") {
      return task;
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Task ${id} wait timed out`)),
        timeoutMs,
      );
    });

    await Promise.race([task.completionPromise, timeoutPromise]);
    return task;
  }

  stop(id: string, signal?: "SIGTERM" | "SIGKILL"): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    if (task.status === "running" && task.proc) {
      if (signal === "SIGKILL") {
        task.proc.kill(9);
      } else {
        task.proc.kill();
      }
      task.abortController.abort();
      return true;
    }

    if (task.status === "pending") {
      task.abortController.abort();
      task.status = "cancelled";
      task.resolveCompletion();
      return true;
    }

    return false;
  }

  list(statusFilter?: string): Task[] {
    const tasks = Array.from(this.tasks.values());
    if (!statusFilter || statusFilter === "all") {
      return tasks;
    }
    return tasks.filter((t) => t.status === statusFilter);
  }

  // NOTE(victor): LOOP-6 fix - Graceful shutdown with SIGTERM → wait → SIGKILL
  async shutdown(gracePeriodMs = 3000): Promise<void> {
    this.accepting = false;
    this.semaphore.drain();

    // Cancel all eviction timers
    for (const timer of this.evictionTimers.values()) {
      clearTimeout(timer);
    }
    this.evictionTimers.clear();

    // Send SIGTERM to running tasks
    const runningTasks: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "running" && task.proc) {
        task.proc.kill();
        task.abortController.abort();
        runningTasks.push(task);
      }
    }

    if (runningTasks.length === 0) return;

    // Wait for graceful termination or force kill
    const graceDeadline = Date.now() + gracePeriodMs;
    for (const task of runningTasks) {
      const remaining = graceDeadline - Date.now();
      if (remaining > 0) {
        try {
          await Promise.race([
            task.completionPromise,
            new Promise((r) => setTimeout(r, remaining)),
          ]);
        } catch {}
      }

      // Force kill if still running
      if (task.status === "running" && task.proc) {
        task.proc.kill(9);
      }
    }
  }

  get size(): number {
    return this.tasks.size;
  }

  get activeCount(): number {
    return this.semaphore.activeCount;
  }

  get waitingCount(): number {
    return this.semaphore.waitingCount;
  }

  clear(): void {
    for (const timer of this.evictionTimers.values()) {
      clearTimeout(timer);
    }
    this.evictionTimers.clear();
    this.tasks.clear();
  }
}

// ============================================================================
// Singleton Registry Instance
// ============================================================================

const registry = new TaskRegistry({ maxConcurrent: 50 });

// ============================================================================
// Tool Definitions
// ============================================================================

const BashTool = tool({
  description:
    "Execute command synchronously, blocks until completion. Returns stdout, stderr, exitCode.",
  args: {
    command: tool.schema.string().describe("Shell command to execute"),
    cwd: tool.schema.string().optional().describe("Working directory"),
    timeout: tool.schema
      .number()
      .optional()
      .describe("Timeout in milliseconds"),
  },
  async execute(args) {
    const id = await registry.spawn(args.command, {
      cwd: args.cwd,
      timeout: args.timeout,
    });
    const task = await registry.wait(id);

    let stdout = "";
    let stderr = "";
    try {
      stdout = await Bun.file(task.stdout).text();
    } catch {}
    try {
      stderr = await Bun.file(task.stderr).text();
    } catch {}

    return JSON.stringify({
      stdout,
      stderr,
      exitCode: task.exitCode,
      status: task.status,
    });
  },
});

const TaskTool = tool({
  description:
    "Spawn background task, returns task ID immediately. Use TaskOutput/TaskWait to check results.",
  args: {
    command: tool.schema.string().describe("Shell command to execute"),
    cwd: tool.schema.string().optional().describe("Working directory"),
    timeout: tool.schema
      .number()
      .optional()
      .describe("Timeout in milliseconds"),
  },
  async execute(args) {
    const id = await registry.spawn(args.command, {
      cwd: args.cwd,
      timeout: args.timeout,
    });
    return JSON.stringify({ taskId: id, message: `Task ${id} spawned` });
  },
});

const TaskOutputTool = tool({
  description: "Get status and partial output of a background task",
  args: {
    taskId: tool.schema.string().describe("Task ID from Task"),
  },
  async execute(args) {
    const task = registry.get(args.taskId);
    if (!task)
      return JSON.stringify({ error: `Task ${args.taskId} not found` });

    const result: Record<string, unknown> = {
      id: task.id,
      status: task.status,
      command: task.command,
      createdAt: task.createdAt,
    };

    if (task.startedAt) result.startedAt = task.startedAt;
    if (task.completedAt && task.startedAt) {
      result.completedAt = task.completedAt;
      result.duration = task.completedAt - task.startedAt;
    }
    if (task.exitCode !== undefined) result.exitCode = task.exitCode;
    if (task.error) result.error = task.error;

    // Read partial output if available (last 10KB)
    if (task.status !== "pending") {
      try {
        const stdout = await Bun.file(task.stdout).text();
        result.stdout = stdout.slice(-10000);
      } catch {}
    }

    return JSON.stringify(result);
  },
});

const TaskWaitTool = tool({
  description: "Wait for background task to complete, returns full results",
  args: {
    taskId: tool.schema.string().describe("Task ID from Task"),
    timeout: tool.schema
      .number()
      .optional()
      .describe("Max wait time in ms (default 30s)"),
  },
  async execute(args) {
    const task = await registry.wait(args.taskId, args.timeout ?? 30000);

    let stdout = "";
    let stderr = "";
    try {
      stdout = await Bun.file(task.stdout).text();
    } catch {}
    try {
      stderr = await Bun.file(task.stderr).text();
    } catch {}

    return JSON.stringify({
      id: task.id,
      status: task.status,
      exitCode: task.exitCode,
      stdout,
      stderr,
      duration:
        task.completedAt && task.startedAt
          ? task.completedAt - task.startedAt
          : 0,
    });
  },
});

const TaskStopTool = tool({
  description: "Stop/cancel a running background task",
  args: {
    taskId: tool.schema.string().describe("Task ID to kill"),
    signal: tool.schema
      .enum(["SIGTERM", "SIGKILL"])
      .optional()
      .describe("Signal to send (default SIGTERM)"),
  },
  async execute(args) {
    const stopped = registry.stop(args.taskId, args.signal);
    return JSON.stringify({ success: stopped, taskId: args.taskId });
  },
});

const TaskListTool = tool({
  description: "List all background tasks with their status",
  args: {
    status: tool.schema
      .enum(["all", "running", "completed", "failed", "pending", "cancelled"])
      .optional()
      .describe("Filter by status"),
  },
  async execute(args) {
    const tasks = registry.list(args.status);
    return JSON.stringify({
      count: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        status: t.status,
        command: t.command.slice(0, 100),
        createdAt: t.createdAt,
        duration:
          t.completedAt && t.startedAt
            ? t.completedAt - t.startedAt
            : undefined,
      })),
    });
  },
});

// ============================================================================
// Plugin Export
// ============================================================================

export const CustomToolPlugin: Plugin = async () => {
  return {
    tool: {
      Bash: BashTool,
      Task: TaskTool,
      TaskOutput: TaskOutputTool,
      TaskWait: TaskWaitTool,
      TaskStop: TaskStopTool,
      TaskList: TaskListTool,
    },
  };
};
