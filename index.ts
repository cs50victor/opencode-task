import { type Plugin, tool } from "@opencode-ai/plugin";
import { AGENT_CONFIGS, type Task, TaskRegistry } from "./utils";

type AgentType = keyof typeof AGENT_CONFIGS;

export const CustomToolPlugin: Plugin = async (input) => {
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
          "Spawn a Claude agent to work on a subtask in the background. Available agents: Explore (codebase search), Plan (architecture design), general-purpose (complex multi-step tasks), claude-code-guide (Claude Code/SDK questions), web-search (research external information). You will receive a notification when complete.",
        args: {
          agent: tool.schema
            .enum([
              "Explore",
              "Plan",
              "general-purpose",
              "claude-code-guide",
              "web-search",
            ])
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

export default CustomToolPlugin;
