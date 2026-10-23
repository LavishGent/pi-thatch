// Loads the extension under plain Node the way Pi's extension loader does
// (jiti, moduleCache off), drives one simulated turn against a mock
// ExtensionAPI, and prints a JSON report. Run by tests/node-runtime.test.ts
// with an isolated env (HOME, XDG_CACHE_HOME, THATCH_*); never imports Bun.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const report = { runtime: typeof Bun === "undefined" ? "node" : "bun", errors: [] };

const handlers = new Map();
const commands = new Map();
const mcpServers = new Map();
const pi = {
  on: (event, handler) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
  registerCommand: (name, opts) => commands.set(name, opts),
  registerMcpServer: (name, config) => mcpServers.set(name, config),
  sendUserMessage: () => {},
  getSessionName: () => "node-fixture",
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
};

try {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const factory = await jiti.import(join(root, "src", "index.ts"), { default: true });
  await factory(pi);

  report.mcpServers = [...mcpServers.keys()];
  report.commands = [...commands.keys()].sort();

  const opts = { appendSystemPrompt: "" };
  handlers.get("before_agent_start")({ type: "before_agent_start", systemPromptOptions: opts });
  report.methodology = opts.appendSystemPrompt.includes("# Persistence");

  const discovered = handlers.get("resources_discover")({ type: "resources_discover", cwd: root, reason: "startup" });
  const skillsDir = discovered?.skillPaths?.[0];
  report.skillsDir = skillsDir ?? null;
  report.skillInstalled = !!skillsDir && existsSync(join(skillsDir, "thatch-session-reflection", "SKILL.md"));

  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: root });
  handlers.get("agent_start")({ type: "agent_start" });
  // Deliberately right after session_start: the handler must wait for the
  // buffer rather than drop the interaction.
  await handlers.get("tool_result")({
    type: "tool_result",
    toolName: "read",
    input: { path: "src/index.ts" },
    content: [{ type: "text", text: "file contents" }],
  });

  const messages = [
    { role: "user", content: [{ type: "text", text: "explain the authentication architecture of this project" }] },
  ];
  const out = await handlers.get("context")({ type: "context", messages });
  report.injected = out ? out.messages[out.messages.length - 1].content[0].text : null;

  await handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, { cwd: root });
  handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
} catch (err) {
  report.errors.push(String(err?.stack ?? err));
}

process.stdout.write(JSON.stringify(report));
