import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piThatch from "../src/index.ts";

// Minimal ExtensionAPI mock capturing registrations.
function makeMockPi() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { description?: string; handler: Function }>();
  const mcpServers = new Map<string, unknown>();
  const sent: string[] = [];
  const pi = {
    on(event: string, handler: Function) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand(name: string, opts: { description?: string; handler: Function }) {
      commands.set(name, opts);
    },
    registerMcpServer(name: string, config: unknown) {
      mcpServers.set(name, config);
    },
    sendUserMessage(content: string) {
      sent.push(content);
    },
    getSessionName: () => "test-session",
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  };
  return { pi, handlers, commands, mcpServers, sent };
}

async function withTempEnv<T>(fn: () => Promise<T>): Promise<T> {
  const cache = mkdtempSync(join(tmpdir(), "pi-thatch-cache-"));
  const prev = { ...process.env };
  process.env.XDG_CACHE_HOME = cache;
  process.env.THATCH_QUEUE_DIR = join(cache, "queue");
  process.env.THATCH_DB_PATH = join(cache, "thatch.db");
  process.env.HOME = cache;
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  try {
    return await fn();
  } finally {
    restore("XDG_CACHE_HOME", prev.XDG_CACHE_HOME);
    restore("THATCH_QUEUE_DIR", prev.THATCH_QUEUE_DIR);
    restore("THATCH_DB_PATH", prev.THATCH_DB_PATH);
    restore("HOME", prev.HOME);
  }
}

test("factory auto-provisions tools, commands, and skills, and wires handlers", async () => {
  await withTempEnv(async () => {
    const { pi, handlers, commands, mcpServers } = makeMockPi();
    await piThatch(pi as never);

    // Tools: thatch MCP server registered automatically.
    expect(mcpServers.has("thatch")).toBe(true);
    expect((mcpServers.get("thatch") as { exposure: string }).exposure).toBe("direct");

    // Commands: the 6 shared actions registered.
    for (const c of ["defrag", "hygiene", "reflect", "refine", "self-review", "peer-review"]) {
      expect(commands.has(c)).toBe(true);
    }

    // Handlers wired.
    for (const ev of [
      "before_agent_start",
      "resources_discover",
      "session_start",
      "session_compact",
      "context",
      "agent_start",
      "tool_result",
      "ui_prompt_start",
      "agent_settled",
      "session_shutdown",
    ]) {
      expect(handlers.has(ev)).toBe(true);
    }

    // Skills provisioned and offered via resources_discover.
    const res = handlers.get("resources_discover")!({ type: "resources_discover", cwd: ".", reason: "startup" });
    expect(res?.skillPaths?.length).toBe(1);
    expect(existsSync(join(res.skillPaths[0], "thatch-session-reflection", "SKILL.md"))).toBe(true);
  });
}, 60_000);

test("methodology is appended to the system prompt once", async () => {
  await withTempEnv(async () => {
    const { pi, handlers } = makeMockPi();
    await piThatch(pi as never);
    const opts = { appendSystemPrompt: "" } as { appendSystemPrompt: string };
    handlers.get("before_agent_start")!({ type: "before_agent_start", systemPromptOptions: opts });
    expect(opts.appendSystemPrompt).toContain("# Persistence");
    const afterFirst = opts.appendSystemPrompt;
    // Idempotent: a second pass does not duplicate it.
    handlers.get("before_agent_start")!({ type: "before_agent_start", systemPromptOptions: opts });
    expect(opts.appendSystemPrompt).toBe(afterFirst);
  });
}, 60_000);

test("a command handler sends the action body as a user message", async () => {
  await withTempEnv(async () => {
    const { pi, commands, sent } = makeMockPi();
    await piThatch(pi as never);
    await commands.get("reflect")!.handler("");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("thatch-session-reflection");
    await commands.get("peer-review")!.handler("PR 42");
    expect(sent[1]).toContain("Focus: PR 42");
  });
}, 60_000);

test("a simulated user turn runs through the context hook without throwing", async () => {
  await withTempEnv(async () => {
    const { pi, handlers } = makeMockPi();
    await piThatch(pi as never);

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, { cwd: process.env.HOME });

    const messages = [
      { role: "user", content: [{ type: "text", text: "explain the authentication architecture of this project" }] },
    ];
    expect(await handlers.get("context")!({ type: "context", messages })).toBeUndefined();

    const midTurn = [
      { role: "user", content: [{ type: "text", text: "do the thing" }] },
      { role: "tool", content: [{ type: "text", text: "result" }] },
    ];
    expect(await handlers.get("context")!({ type: "context", messages: midTurn })).toBeUndefined();

    handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" });
  });
}, 60_000);
