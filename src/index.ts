/**
 * pi-thatch - a one-stop-shop that brings thatch (persistent memory +
 * methodology) to Pi. Installing this extension is all a user does; it
 * provisions everything automatically and the user never touches thatch:
 *
 *   - Tools:       registers the thatch MCP server (`pi.registerMcpServer`).
 *   - Methodology: appended to the system prompt via `before_agent_start`.
 *   - Commands:    6 `/` actions registered from thatch's own definitions.
 *   - Skills:      installed to a cache dir and exposed via `resources_discover`.
 *
 * Plus the ambient behaviors that need event hooks:
 *   - Prompt-aware recall + prediction + behavior nudge (in-process).
 *   - Session-start + post-compaction re-familiarization.
 *   - Fact extraction (buffer + drain-on-save + nudge / background).
 *   - Pause/done desktop alerts (opt-in).
 *
 * Event handlers get ExtensionContext (no executeTool), so ambient logic reads
 * thatch's store in-process; writes flow through the MCP tools (single writer).
 * Requires Pi under Bun (bun:sqlite); under Node it degrades to inert.
 */
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ContextEvent,
  ToolResultEvent,
  SessionStartEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  AgentStartEvent,
  AgentSettledEvent,
  UIPromptStartEvent,
  BeforeAgentStartEvent,
  ResourcesDiscoverEvent,
} from "@earendil-works/pi-coding-agent";
import {
  ThatchSession,
  ExtractionBuffer,
  piExtractionNudge,
  piExtractionChildPrompt,
  getMethodology,
  getCommandDefs,
  provisionSkills,
} from "./thatch-core.ts";

const THATCH_VERSION = "0.2.9";
const METHODOLOGY_MARKER = "# Persistence";

type AgentMessage = ContextEvent["messages"][number];
type ExtractionMode = "off" | "nudge" | "background";

function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } => !!p && (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

function debug(msg: string): void {
  if (process.env.PI_THATCH_DEBUG) console.error(`[pi-thatch] ${msg}`);
}

export default async function piThatch(pi: ExtensionAPI): Promise<void> {
  const isChild = !!process.env.PI_THATCH_CHILD;
  const mode: ExtractionMode = (process.env.PI_THATCH_EXTRACTION as ExtractionMode) || "off";

  let session: ThatchSession | null = null;
  let building: Promise<void> | null = null;
  let buffer: ExtractionBuffer | null = null;
  let lastNudgedPrompt: string | null = null;
  let spawning = false;
  let pendingFamiliarize = false;
  let toolsThisRun = 0;

  let methodology: string | null = null;
  let skillsDir: string | null = null;

  // ---- Auto-provisioning: the user installs only this extension -------------
  if (!isChild) {
    try {
      pi.registerMcpServer("thatch", {
        command: "bunx",
        args: [`@jeffober/thatch@${THATCH_VERSION}`, "mcp"],
        exposure: "direct",
        description: "Persistent cross-session memory and methodology",
      });
    } catch (err) {
      debug(`registerMcpServer failed: ${err}`);
    }

    try {
      for (const cmd of await getCommandDefs()) {
        pi.registerCommand(cmd.name, {
          description: cmd.description,
          handler: async (args: string) => {
            const focus = args?.trim();
            pi.sendUserMessage(focus ? `${cmd.body}\n\nFocus: ${focus}` : cmd.body);
          },
        });
      }
    } catch (err) {
      debug(`command registration failed: ${err}`);
    }

    try {
      methodology = await getMethodology();
    } catch (err) {
      debug(`methodology load failed: ${err}`);
    }

    try {
      const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
      skillsDir = await provisionSkills(join(cache, "pi-thatch", "skills"));
    } catch (err) {
      debug(`skill provisioning failed: ${err}`);
    }
  }

  const notify = async (title: string, message: string) => {
    if (!process.env.PI_THATCH_NOTIFY) return;
    try {
      if (process.platform === "darwin") {
        await pi.exec("osascript", [
          "-e",
          `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
        ]);
      } else if (process.platform === "linux") {
        await pi.exec("notify-send", [title, message]);
      }
    } catch {
      /* best-effort */
    }
  };

  const disposeSession = () => {
    try {
      session?.dispose();
    } finally {
      session = null;
      building = null;
      buffer = null;
      lastNudgedPrompt = null;
    }
  };

  // Methodology into the (cache-stable) system prompt.
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    if (isChild || !methodology) return;
    const opts = event.systemPromptOptions;
    if (!opts.appendSystemPrompt.includes(METHODOLOGY_MARKER)) {
      opts.appendSystemPrompt = opts.appendSystemPrompt
        ? `${opts.appendSystemPrompt}\n\n${methodology}`
        : methodology;
    }
  });

  // Contribute thatch's skills to the session.
  pi.on("resources_discover", (_e: ResourcesDiscoverEvent) => {
    if (isChild || !skillsDir) return;
    return { skillPaths: [skillsDir] };
  });

  pi.on("session_start", (_e: SessionStartEvent, ctx) => {
    if (isChild) return;
    disposeSession();
    const sessionId = randomUUID();
    building = Promise.all([
      ThatchSession.create(ctx.cwd).then((s) => {
        session = s;
      }),
      ExtractionBuffer.create(sessionId).then((b) => {
        buffer = b;
      }),
    ])
      .then(() => {
        pendingFamiliarize = true;
      })
      .catch((err) => {
        debug(`session init failed: ${err}`);
      });
  });

  pi.on("session_compact", (_e: SessionCompactEvent) => {
    if (isChild) return;
    pendingFamiliarize = true;
    lastNudgedPrompt = null;
  });

  pi.on("agent_start", (_e: AgentStartEvent) => {
    toolsThisRun = 0;
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    if (isChild) return;
    toolsThisRun++;
    if (!buffer) return;
    try {
      buffer.buffer(event.toolName, (event.input ?? {}) as Record<string, unknown>, textOf(event));
    } catch (err) {
      debug(`buffer failed: ${err}`);
    }
  });

  pi.on("ui_prompt_start", async (event: UIPromptStartEvent) => {
    if (isChild) return;
    await notify("Pi needs your input", event.title ?? `${event.kind} prompt`);
  });

  // Recall/prediction/behavior + re-familiarization + extraction nudge, injected
  // as ephemeral trailing context at the start of a user-driven turn.
  pi.on("context", async (event: ContextEvent) => {
    if (isChild) return;
    if (building) await building;

    const messages = event.messages;
    const last = messages[messages.length - 1];
    if (!last || (last as { role?: string }).role !== "user") return;

    const prompt = textOf(last as { content?: unknown });
    const parts: string[] = [];

    if (pendingFamiliarize && session) {
      pendingFamiliarize = false;
      try {
        const fam = await session.familiarize();
        if (fam) parts.push(fam);
      } catch (err) {
        debug(`familiarize failed: ${err}`);
      }
    }

    if (prompt && prompt !== lastNudgedPrompt) {
      lastNudgedPrompt = prompt;
      if (session) {
        try {
          const nudge = await session.computeNudges(prompt);
          if (nudge) parts.push(nudge);
        } catch (err) {
          debug(`recall nudge failed: ${err}`);
        }
      }
      if (mode === "nudge" && buffer) {
        const count = buffer.count();
        if (count > 0) {
          parts.push(piExtractionNudge(count, buffer.missed(), buffer.sessionId));
          buffer.bumpMissed();
        }
      }
    }

    if (parts.length === 0) return;
    debug(`injected ${parts.length} nudge part(s)`);
    const injected: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: parts.join("\n\n") }],
    } as AgentMessage;
    return { messages: [...messages, injected] };
  });

  pi.on("agent_settled", async (event: AgentSettledEvent, ctx) => {
    if (isChild || event.aborted) return;
    if (mode === "background" && buffer && !spawning) {
      const count = buffer.count();
      if (count > 0) {
        spawning = true;
        try {
          await spawnExtractionChild(buffer, count, ctx.cwd);
        } catch (err) {
          debug(`extraction spawn failed: ${err}`);
        } finally {
          spawning = false;
        }
      }
    }
    if (toolsThisRun > 0) {
      const project = ctx.cwd.split("/").pop() ?? "session";
      await notify(pi.getSessionName?.() ?? "pi", `Finished in ${project}`);
    }
  });

  pi.on("session_shutdown", (_e: SessionShutdownEvent) => {
    disposeSession();
  });
}

/**
 * Fire-and-forget a background Pi session that drains the extraction queue.
 * Uses Bun.spawn (ExecOptions has no env) so PI_THATCH_CHILD marks the child
 * inert. The child shares THATCH_* env so it reads the same DB/queue.
 */
async function spawnExtractionChild(buffer: ExtractionBuffer, count: number, cwd: string): Promise<void> {
  const bin = process.env.PI_THATCH_PI_BIN || "pi-bun";
  const prompt = piExtractionChildPrompt(count, buffer.sessionId);
  const spawn = (globalThis as { Bun?: { spawn: (cmd: string[], opts: unknown) => unknown } }).Bun?.spawn;
  if (!spawn) {
    debug("Bun.spawn unavailable; skipping background extraction");
    return;
  }
  debug(`spawning background extraction (${count} interactions) via ${bin}`);
  spawn([bin, "-p", "--no-session", "--session-dir", tmpdir(), prompt], {
    cwd,
    env: { ...process.env, PI_THATCH_CHILD: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}
