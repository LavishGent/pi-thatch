// Loads the extension under plain Node the way Pi's extension loader does
// (jiti, moduleCache off), drives simulated turns against a mock ExtensionAPI,
// and prints a JSON report. Run by tests/node-runtime.test.ts with an isolated
// env (HOME, XDG_CACHE_HOME, THATCH_*); never imports Bun.
//
// PRE_TURNS (default 0): user turns to run BEFORE the thatch sideband server
// starts, to exercise the "server not up yet" path. Then the fixture starts
// thatch's real SidebandServer (fake model + DB) on the socket the MCP server
// would own for THATCH_DB_PATH, and runs one more turn.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const preTurns = Number(process.env.PRE_TURNS ?? "0");
const report = { runtime: typeof Bun === "undefined" ? "node" : "bun", errors: [], turns: [] };

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

// A stand-in for the MCP server's warm model and DB behind the real socket.
const fakeModel = { queryEmbed: async () => new Float32Array([1, 0, 0]) };
const fakeDb = {
  search: (_stores, _e, opts) =>
    [
      { label: "architecture overview", store: "global", _score: 0.92 },
      { label: "auth flow", store: "global", _score: 0.88 },
    ].slice(0, opts.limit),
  scorePredictionNudge: () => [],
  scoreBehaviorNudge: () => [],
};

async function turn(text) {
  const messages = [{ role: "user", content: [{ type: "text", text }] }];
  const out = await handlers.get("context")({ type: "context", messages });
  report.turns.push(out ? out.messages[out.messages.length - 1].content[0].text : null);
}

let server;
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

  for (let i = 0; i < preTurns; i++) await turn(`before the server is up, question number ${i}`);

  const require = createRequire(join(root, "src", "index.ts"));
  const sideband = await jiti.import(join(dirname(require.resolve("@jeffober/thatch")), "sideband.ts"));
  const sock = sideband.sidebandSocketPath(process.env.THATCH_DB_PATH);
  server = new sideband.SidebandServer(sock, fakeModel, fakeDb);
  server.start();
  for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 10));

  await turn("explain the authentication architecture of this project");

  await handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, { cwd: root });
  handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
} catch (err) {
  report.errors.push(String(err?.stack ?? err));
} finally {
  server?.stop();
}

process.stdout.write(JSON.stringify(report));
