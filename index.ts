import { appendFile } from "node:fs/promises";
import type { PluginInput } from "@opencode-ai/plugin";
import { type Plugin, tool } from "@opencode-ai/plugin";

// NOTE(victor): Agent configs mirror Claude Code's Task tool agent types for CLI compatibility.
export type AgentType =
  | "Explore"
  | "Plan"
  | "general-purpose"
  | "claude-code-guide";

export interface AgentConfig {
  description: string;
  prompt: string;
  tools: string[] | null;
  model?: "sonnet" | "opus" | "haiku";
}

export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  Explore: {
    description:
      "Fast agent specialized for exploring codebases. Use when you need to quickly find files by patterns, search code for keywords, or answer questions about the codebase.",
    prompt:
      "You are an exploration specialist. Search thoroughly using Glob, Grep, and Read. Report findings concisely. Do not modify any files.",
    tools: [
      "Glob",
      "Grep",
      "Read",
      "Bash",
      "LSP",
      "WebFetch",
      "WebSearch",
      "AskUserQuestion",
    ],
  },

  Plan: {
    description:
      "Software architect agent for designing implementation plans. Use when you need to plan implementation strategy. Returns step-by-step plans, identifies critical files, considers architectural trade-offs.",
    prompt:
      "You are a software architect. Analyze requirements, explore the codebase thoroughly, and design clear implementation plans with specific steps. Do not modify any files.",
    tools: [
      "Glob",
      "Grep",
      "Read",
      "Bash",
      "LSP",
      "WebFetch",
      "WebSearch",
      "AskUserQuestion",
    ],
  },

  "general-purpose": {
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use for heavy lifting when simpler agents are insufficient.",
    prompt:
      "You are a general-purpose assistant. Complete the assigned task thoroughly and report results.",
    tools: null,
  },

  "claude-code-guide": {
    description:
      "Expert on Claude Code CLI features, hooks, slash commands, MCP servers, settings, IDE integrations. Also covers Claude Agent SDK and Claude API usage.",
    prompt:
      "You are a Claude Code expert. Answer questions about Claude Code features, Agent SDK, and API usage accurately. Search documentation and web resources as needed.",
    tools: ["Glob", "Grep", "Read", "WebFetch", "WebSearch"],
  },
} as const;

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
    // NOTE(victor): Decrement acquired BEFORE resolving next waiter to keep activeCount accurate.
    // If we resolve first, the awakened task increments acquired while we still hold our count,
    // causing activeCount to briefly exceed maxConcurrent.
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

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  sessionID?: string; // For push notification on completion
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
  // NOTE(victor): Promise-based completion allows wait() to block without polling.
  // Polling at 10ms intervals wastes CPU cycles; awaiting a promise yields to the event loop.
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
}

export function createTask(
  id: string,
  command: string,
  cwd: string,
  timeout?: number,
  sessionID?: string,
): Task {
  let resolveCompletion!: () => void;
  const completionPromise = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  return {
    id,
    sessionID,
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
  client?: PluginInput["client"]; // For push notifications on task completion
}

export class TaskRegistry {
  private tasks = new Map<string, Task>();
  private semaphore: Semaphore;
  private nextId = 0;
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private accepting = true;
  private options: Required<Omit<RegistryOptions, "client">>;
  private client?: PluginInput["client"];

  constructor(options: RegistryOptions = {}) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 50,
      taskTTL: options.taskTTL ?? 30000,
      maxOutputSize: options.maxOutputSize ?? 5 * 1024 * 1024,
    };
    this.client = options.client;
    this.semaphore = new Semaphore(this.options.maxConcurrent);
  }

  async spawn(
    command: string,
    options: { timeout?: number; cwd?: string; sessionID?: string } = {},
  ): Promise<string> {
    if (!this.accepting) {
      throw new Error("Registry is shutting down");
    }

    const id = `task-${this.nextId++}`;
    const cwd = options.cwd ?? process.cwd();
    const task = createTask(
      id,
      command,
      cwd,
      options.timeout,
      options.sessionID,
    );
    this.tasks.set(id, task);
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
      this.notifyCompletion(task);
    }
  }

  // NOTE(victor): Push notification on completion eliminates polling.
  // Model receives task ID and can fetch full output via TaskOutput if needed.
  private notifyCompletion(task: Task): void {
    if (!this.client || !task.sessionID) return;

    this.client.session.promptAsync({
      path: { id: task.sessionID },
      body: {
        parts: [
          {
            type: "text",
            text: `<task-notification>\n<task-id>${task.id}</task-id>\n<status>${task.status}</status>\n<exit-code>${task.exitCode ?? "N/A"}</exit-code>\n<stdout-path>${task.stdout}</stdout-path>\n</task-notification>`,
          },
        ],
      },
    });
  }

  // NOTE(victor): TTL-based eviction prevents unbounded memory growth from completed tasks.
  // Without eviction, long-running agents accumulate thousands of task records.
  // 30s default aligns with Bun's GC slow-mode interval for efficient cleanup.
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

  // NOTE(victor): Graceful shutdown sends SIGTERM first, allowing processes to clean up
  // (flush buffers, remove temp files). SIGKILL after grace period handles hung processes.
  async shutdown(gracePeriodMs = 3000): Promise<void> {
    this.accepting = false;
    this.semaphore.drain();
    for (const timer of this.evictionTimers.values()) {
      clearTimeout(timer);
    }
    this.evictionTimers.clear();
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

export const CustomToolPlugin: Plugin = async (input) => {
  // NOTE(victor): Registry created per-plugin with client for push notifications.
  // Tools access registry via closure.
  const registry = new TaskRegistry({
    maxConcurrent: 50,
    client: input.client,
  });

  return {
    tool: {
      Task: tool({
        description:
          "Spawn background task. You will receive a notification with stdout/stderr file paths when it completes. Use the Read tool to get output.",
        args: {
          command: tool.schema.string().describe("Shell command to execute"),
          cwd: tool.schema.string().optional().describe("Working directory"),
          timeout: tool.schema
            .number()
            .optional()
            .describe("Timeout in milliseconds"),
        },
        async execute(args, context) {
          const id = await registry.spawn(args.command, {
            cwd: args.cwd,
            timeout: args.timeout,
            sessionID: context.sessionID,
          });
          return JSON.stringify({
            taskId: id,
            message: `Task ${id} spawned. You will receive a notification when complete.`,
          });
        },
      }),

      TaskStop: tool({
        description: "Stop/cancel a running background task",
        args: {
          taskId: tool.schema.string().describe("Task ID to stop"),
          signal: tool.schema
            .enum(["SIGTERM", "SIGKILL"])
            .optional()
            .describe("Signal to send (default SIGTERM)"),
        },
        async execute(args) {
          const stopped = registry.stop(args.taskId, args.signal);
          return JSON.stringify({ success: stopped, taskId: args.taskId });
        },
      }),

      TaskList: tool({
        description: "List all background tasks with their status",
        args: {
          status: tool.schema
            .enum([
              "all",
              "running",
              "completed",
              "failed",
              "pending",
              "cancelled",
            ])
            .optional()
            .describe("Filter by status"),
        },
        async execute(args) {
          const tasks = registry.list(args.status);
          return JSON.stringify({
            count: tasks.length,
            tasks: tasks.map((t: Task) => ({
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
      }),

      AgentTask: tool({
        description:
          "Spawn a Claude agent to work on a subtask in the background. Available agents: Explore (codebase search), Plan (architecture design), general-purpose (complex multi-step tasks), claude-code-guide (Claude Code/SDK questions). You will receive a notification when complete.",
        args: {
          agent: tool.schema
            .enum(["Explore", "Plan", "general-purpose", "claude-code-guide"])
            .describe("Agent type to spawn"),
          prompt: tool.schema.string().describe("Task prompt for the agent"),
          cwd: tool.schema.string().optional().describe("Working directory"),
          timeout: tool.schema
            .number()
            .optional()
            .describe("Timeout in milliseconds"),
        },
        async execute(args, context) {
          const agentType = args.agent as AgentType;
          const config = AGENT_CONFIGS[agentType];
          const agentDef = {
            [agentType]: {
              description: config.description,
              prompt: config.prompt,
            },
          };

          const cmdParts = [
            "claude",
            "--agents",
            JSON.stringify(agentDef),
            "--agent",
            agentType,
          ];

          if (config.tools !== null) {
            cmdParts.push("--tools", config.tools.join(","));
          }

          cmdParts.push(
            "--output-format",
            "stream-json",
            "--print",
            "-p",
            args.prompt,
          );

          const command = cmdParts
            .map((p) => (p.includes(" ") || p.includes('"') ? `'${p}'` : p))
            .join(" ");

          const id = await registry.spawn(command, {
            cwd: args.cwd,
            timeout: args.timeout,
            sessionID: context.sessionID,
          });

          return JSON.stringify({
            taskId: id,
            agent: agentType,
            message: `Agent ${agentType} spawned as ${id}. You will receive a notification when complete.`,
          });
        },
      }),
    },
  };
};
