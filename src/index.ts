/**
 * pi-thatch - in-process thatch ambient behaviors for Pi.
 *
 * Event handlers receive ExtensionContext (no executeTool), so ambient logic
 * reads thatch's store in-process. This stage wires the prompt-aware recall /
 * prediction / behavior nudge plus session-start and post-compaction
 * re-familiarization, injected as ephemeral turn context.
 */
import type {
  ExtensionAPI,
  ContextEvent,
  SessionStartEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { ThatchSession } from "./thatch-core.ts";

type AgentMessage = ContextEvent["messages"][number];

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

export default function piThatch(pi: ExtensionAPI): void {
  let session: ThatchSession | null = null;
  let building: Promise<void> | null = null;
  let lastNudgedPrompt: string | null = null;
  let pendingFamiliarize = false;

  const disposeSession = () => {
    try {
      session?.dispose();
    } finally {
      session = null;
      building = null;
      lastNudgedPrompt = null;
    }
  };

  pi.on("session_start", (_e: SessionStartEvent, ctx) => {
    disposeSession();
    building = ThatchSession.create(ctx.cwd)
      .then((s) => {
        session = s;
        pendingFamiliarize = true;
      })
      .catch((err) => {
        debug(`session init failed: ${err}`);
      });
  });

  // After a compaction the model loses its in-context history; re-familiarize it
  // with the project's foundational memories on the next turn.
  pi.on("session_compact", (_e: SessionCompactEvent) => {
    pendingFamiliarize = true;
    lastNudgedPrompt = null;
  });

  // Recall/prediction/behavior nudge + re-familiarization, injected as ephemeral
  // trailing context at the start of a user-driven turn.
  pi.on("context", async (event: ContextEvent) => {
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
    }

    if (parts.length === 0) return;
    debug(`injected ${parts.length} nudge part(s)`);
    const injected: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: parts.join("\n\n") }],
    } as AgentMessage;
    return { messages: [...messages, injected] };
  });

  pi.on("session_shutdown", (_e: SessionShutdownEvent) => {
    disposeSession();
  });
}
