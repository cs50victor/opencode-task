# opencode-task

Opencode-ai plugin providing background task execution tools. TypeScript, Bun runtime, published to npm as `opencode-task`.

## Structure

```
index.ts    — Plugin entry. Exports CustomToolPlugin (default). Defines 4 tools: Task, TaskStop, TaskList, AgentTask.
utils.ts    — Core internals: TaskRegistry, Semaphore, Task interface, createTask factory, AGENT_CONFIGS (5 agent types).
tests/      — stress.test.ts: stress tests, unit tests, TTL eviction, shutdown, benchmarks.
dist/       — Build output (single bundled index.js). Gitignored.
```

## Tools Exposed

| Tool | Purpose |
|---|---|
| `Task` | Spawn shell command as background task |
| `TaskStop` | Kill running task (SIGTERM then SIGKILL) |
| `TaskList` | List tasks filtered by status |
| `AgentTask` | Spawn Claude sub-agent (Explore, Plan, general-purpose, claude-code-guide, web-search) |

## Key Internals

- **TaskRegistry**: Central orchestrator. Owns task lifecycle (spawn/execute/wait/stop/evict/shutdown). Map-backed. TTL eviction (30s default, LRU-style reset on access).
- **Semaphore**: Counting semaphore (default 50). Promise-based FIFO queue. `drain()` for shutdown.
- **Push notifications**: Task completion triggers `client.session.promptAsync()` — no polling.
- **Output**: stdout/stderr written to temp files (not buffered in memory).

## Commands

```sh
bun install              # install deps
bun run build            # bun build index.ts --outdir dist --target node
bun run typecheck        # tsc --noEmit
bun run lint             # biome check .
bun run lint:fix         # biome check --write .
bun test                 # run all tests (bun:test runner)
```

## Stack

- **Runtime**: Bun (uses Bun.spawn, Bun.file directly — not Node-portable)
- **Language**: TypeScript, ESNext, strict mode
- **Linter/Formatter**: Biome 1.9 (spaces, indent 2)
- **CI**: GitHub Actions — lint + typecheck + build on all pushes; npm publish on GitHub release
- **Commit convention**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`)
- **Package manager**: Bun (bun.lock)

## Engineering Rules

- All engineering decisions must be benchmarked for performance. Use `bun test` to run the stress/benchmark suite (`tests/stress.test.ts`) and validate that changes do not regress throughput, memory, FD usage, or main-thread responsiveness.

## Architecture Notes

- Flat module structure: two source files, no nested dirs. Plugin pattern via `@opencode-ai/plugin`.
- `index.ts` = public surface (tool definitions + Zod schemas). `utils.ts` = all domain logic.
- AgentTask constructs `claude` CLI invocations with `--agents` JSON and `--tools` whitelists.
- Deferred promise pattern on each Task for event-driven completion (no polling).
- Two-phase shutdown: SIGTERM, grace period, SIGKILL. Semaphore drain rejects all waiters.
