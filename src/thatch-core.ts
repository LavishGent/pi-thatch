/**
 * Blast door: the ONLY module that reaches into @jeffober/thatch's
 * non-exported internals. Everything here is pinned to thatch 0.2.9 and
 * validated by tests/thatch-core.test.ts; if an upgrade moves these symbols,
 * that test fails loudly instead of the extension misbehaving at runtime.
 *
 * thatch's package `exports` only expose "." and "./tui", so bare subpath
 * imports (`@jeffober/thatch/src/db`) are blocked. We resolve the package
 * root from its "." entry and import the core files by absolute path, which
 * the published package ships as raw TypeScript (Bun loads it directly).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// --- Minimal structural types for the thatch internals we touch -------------

export interface NudgeMatch {
  label: string;
  score: number;
}

export interface EmbeddingModel {
  queryEmbed(text: string): Promise<Float32Array>;
  passageEmbed(text: string): Promise<Float32Array>;
  dispose?(): Promise<void> | void;
}

export interface MemoryRow {
  label: string;
  store: string;
  _score: number;
}

export interface ThatchDBLike {
  search(
    stores: string[],
    queryEmbedding: Float32Array,
    opts?: { branch?: string; limit?: number; includeArchived?: boolean },
  ): MemoryRow[];
  scorePredictionNudge(stores: string[], embedding: Float32Array, threshold: number, limit?: number): unknown[];
  scoreBehaviorNudge(stores: string[], embedding: Float32Array, threshold: number, limit?: number): unknown[];
  close?(): void;
}

export interface BatchToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  tool_response: string | unknown[];
}

interface ThatchCore {
  ThatchDB: new (dbPath: string, opts?: unknown) => ThatchDBLike;
  repoPathCache: (db: ThatchDBLike) => unknown;
  BgeEmbeddingModel: new (modelName: string) => EmbeddingModel;
  detectRepo: (projectDir: string, cache: unknown) => Promise<string>;
  recallNudge: (matches: NudgeMatch[]) => string;
  predictionNudge: (items: unknown[]) => string;
  behaviorNudge: (items: unknown[]) => string;
  // extract-queue.ts (file-backed, shared with the thatch MCP server process)
  appendBatch: (sessionID: string, toolCalls: BatchToolCall[]) => void;
  peekQueue: (sessionID: string) => unknown[];
  getMissedCount: (sessionID: string) => number;
  incrementMissedCount: (sessionID: string) => void;
  resetMissedCount: (sessionID: string) => void;
  // provisioning (methodology / commands / skills)
  cursorInstructions: () => string;
  mcpToolName: (name: string) => string;
  actionDefs: (tool: (name: string) => string) => ActionDef[];
  installSkills: (skillsDir: string) => unknown;
}

export interface ActionDef {
  name: string;
  description: string;
  body: string;
  opencodeOnly?: boolean;
}

// --- Package-root resolution + deep import -----------------------------------

function thatchSrcDir(): string {
  const require = createRequire(import.meta.url);
  // The "." export resolves to <root>/src/index.ts; walk up one level to <root>/src.
  const entry = require.resolve("@jeffober/thatch");
  return dirname(entry); // <root>/src
}

let cached: ThatchCore | null = null;

export async function loadThatchCore(): Promise<ThatchCore> {
  if (cached) return cached;
  const src = thatchSrcDir();
  const [db, embeddings, git, prompts, queue, commands, skills] = await Promise.all([
    import(join(src, "db.ts")),
    import(join(src, "embeddings.ts")),
    import(join(src, "git.ts")),
    import(join(src, "prompts.ts")),
    import(join(src, "extract-queue.ts")),
    import(join(src, "commands.ts")),
    import(join(src, "skills.ts")),
  ]);
  cached = {
    ThatchDB: db.ThatchDB,
    repoPathCache: db.repoPathCache,
    BgeEmbeddingModel: embeddings.BgeEmbeddingModel,
    detectRepo: git.detectRepo,
    recallNudge: prompts.recallNudge,
    predictionNudge: prompts.predictionNudge,
    behaviorNudge: prompts.behaviorNudge,
    appendBatch: queue.appendBatch,
    peekQueue: queue.peekQueue,
    getMissedCount: queue.getMissedCount,
    incrementMissedCount: queue.incrementMissedCount,
    resetMissedCount: queue.resetMissedCount,
    cursorInstructions: prompts.cursorInstructions,
    mcpToolName: prompts.mcpToolName,
    actionDefs: commands.actionDefs,
    installSkills: skills.installSkills,
  };
  return cached;
}

// --- Config (mirrors thatch's own env chain) ---------------------------------

export interface ThatchConfig {
  projectDir: string;
  dbPath: string;
  modelName: string;
  recallThreshold: number;
  predictionThreshold: number;
  behaviorThreshold: number;
  minPromptLen: number;
}

export function resolveConfig(projectDir: string, env: NodeJS.ProcessEnv = process.env): ThatchConfig {
  const home = env.HOME ?? "/tmp";
  const configHome = env.XDG_CONFIG_HOME ?? `${home}/.config`;
  return {
    projectDir: env.THATCH_PROJECT_DIR ?? projectDir,
    dbPath: env.THATCH_DB_PATH ?? `${configHome}/thatch/thatch.db`,
    modelName: env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5",
    recallThreshold: parseFloat(env.THATCH_RECALL_THRESHOLD ?? "0.55"),
    predictionThreshold: parseFloat(env.THATCH_PREDICTION_THRESHOLD ?? "0.60"),
    behaviorThreshold: parseFloat(env.THATCH_BEHAVIOR_THRESHOLD ?? "0.60"),
    minPromptLen: 10,
  };
}

// --- Session: in-process memory access for the ambient nudges ----------------

export class ThatchSession {
  private constructor(
    private readonly core: ThatchCore,
    private readonly db: ThatchDBLike,
    private readonly model: EmbeddingModel,
    readonly stores: string[],
    readonly cfg: ThatchConfig,
  ) {}

  static async create(projectDir: string, env: NodeJS.ProcessEnv = process.env): Promise<ThatchSession> {
    const core = await loadThatchCore();
    const cfg = resolveConfig(projectDir, env);
    const db = new core.ThatchDB(cfg.dbPath);
    const detected = await core.detectRepo(cfg.projectDir, core.repoPathCache(db));
    const repo = detected === "unknown" ? "global" : detected;
    const model = new core.BgeEmbeddingModel(cfg.modelName);
    // De-duplicate stores while keeping the project store first, global second.
    const stores = repo === "global" ? ["global"] : [repo, "global"];
    return new ThatchSession(core, db, model, stores, cfg);
  }

  /**
   * The prompt-aware recall + prediction + behavior nudge, mirroring thatch's
   * opencode runtime. Returns the combined nudge text, or null when nothing
   * fires. Best-effort: each sub-nudge is independently guarded.
   */
  /**
   * Proactive foundational recall, injected once at session start and again
   * after a compaction (mirrors opencode's session-start reminder and
   * post-compaction re-familiarization). Uses a standing query and a lower
   * cutoff than the prompt-aware nudge, since it is deliberate rather than
   * prompt-triggered. Returns null on a fresh/empty store (no noise).
   */
  async familiarize(): Promise<string | null> {
    let embedding: Float32Array;
    try {
      embedding = await this.model.queryEmbed(
        "project architecture, conventions, decisions, and user preferences",
      );
    } catch {
      return null;
    }
    let rows: MemoryRow[];
    try {
      rows = this.db.search(this.stores, embedding, { limit: 6 });
    } catch {
      return null;
    }
    const top = rows.filter((r) => r._score >= 0.3).slice(0, 5);
    if (top.length === 0) return null;
    const labels = top.map((r) => `"${r.label}"`).join(", ");
    const word = top.length === 1 ? "memory" : "memories";
    return (
      `[thatch] Session context: ${top.length} foundational ${word} exist for this project ` +
      `(${labels}). Recall what you need with mcp__thatch__memory_recall before proceeding - ` +
      `memories are pointers, verify against source. This is a system note, not user input.`
    );
  }

  async computeNudges(prompt: string): Promise<string | null> {
    if (prompt.trim().length < this.cfg.minPromptLen) return null;
    let embedding: Float32Array;
    try {
      embedding = await this.model.queryEmbed(prompt);
    } catch {
      return null;
    }
    const parts: string[] = [];

    try {
      const results = this.db.search(this.stores, embedding, { limit: 5 });
      const matches: NudgeMatch[] = results
        .filter((r) => r._score >= this.cfg.recallThreshold)
        .map((r) => ({ label: r.label, score: Math.round(r._score * 1000) / 1000 }));
      if (matches.length > 0) parts.push(this.core.recallNudge(matches));
    } catch {
      /* best-effort */
    }

    try {
      const preds = this.db.scorePredictionNudge(this.stores, embedding, this.cfg.predictionThreshold);
      if (preds.length > 0) parts.push(this.core.predictionNudge(preds));
    } catch {
      /* best-effort */
    }

    try {
      const behaviors = this.db.scoreBehaviorNudge(this.stores, embedding, this.cfg.behaviorThreshold);
      if (behaviors.length > 0) parts.push(this.core.behaviorNudge(behaviors));
    } catch {
      /* best-effort */
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  dispose(): void {
    try {
      this.db.close?.();
    } catch {
      /* ignore */
    }
    try {
      void this.model.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

// --- Fact-extraction queue (file-backed, shared with the MCP server) ---------

/**
 * Buffers non-meta tool interactions for later fact extraction, reusing
 * thatch's own `extract-queue`. The queue is keyed by `sessionId` and written
 * under `$XDG_CACHE_HOME/thatch/queue`, the same location the thatch MCP
 * server reads from `get_extraction_payload` - so the extension buffers and
 * the agent (or an extraction child) drains, across processes.
 *
 * thatch's `appendBatch` filters meta tools (`mcp__thatch__*`, skill/task/
 * agent) itself and self-drains the queue when it sees a `memory_remember`
 * call, so feeding it every tool result reproduces opencode's drain-on-save.
 */
export class ExtractionBuffer {
  constructor(
    private readonly core: Pick<
      ThatchCore,
      "appendBatch" | "peekQueue" | "getMissedCount" | "incrementMissedCount" | "resetMissedCount"
    >,
    readonly sessionId: string,
  ) {}

  static async create(sessionId: string): Promise<ExtractionBuffer> {
    return new ExtractionBuffer(await loadThatchCore(), sessionId);
  }

  buffer(toolName: string, input: Record<string, unknown>, response: string): void {
    try {
      this.core.appendBatch(this.sessionId, [
        { tool_name: toolName, tool_input: input ?? {}, tool_response: response },
      ]);
    } catch {
      /* best-effort */
    }
  }

  count(): number {
    try {
      return this.core.peekQueue(this.sessionId).length;
    } catch {
      return 0;
    }
  }

  missed(): number {
    try {
      return this.core.getMissedCount(this.sessionId);
    } catch {
      return 0;
    }
  }

  bumpMissed(): void {
    try {
      this.core.incrementMissedCount(this.sessionId);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Pi's extraction nudge. Unlike thatch's `extractionNudge` (which tells the
 * model to spawn a background sub-agent - Pi has no such tool), this asks the
 * agent to extract inline via the MCP tools, escalating with missed count.
 */
export function piExtractionNudge(count: number, missed: number, sessionId: string): string {
  const plural = count === 1 ? "" : "s";
  const steps =
    `Call mcp__thatch__get_extraction_payload with session_id "${sessionId}" to retrieve them, ` +
    `run the thatch-fact-extractor skill to distil durable facts, save each with ` +
    `mcp__thatch__memory_remember, then call mcp__thatch__extraction_done with session_id "${sessionId}" ` +
    `(even if nothing was worth saving).`;
  if (missed >= 3) {
    return (
      `[thatch] YOU ARE IGNORING EXTRACTION. ${count} tool interaction${plural} are queued and unprocessed. ` +
      `${steps} This is a system nudge, not user input.`
    );
  }
  return (
    `[thatch] ${count} tool interaction${plural} are queued for fact extraction. ${steps} ` +
    `This is a system nudge, not user input - after extracting, continue with the user's request ` +
    `(or keep waiting if nothing is pending).`
  );
}

// --- Auto-provisioning (methodology / commands / skills) ---------------------

/** The thatch methodology, flavored for Pi, for the system prompt. */
export async function getMethodology(): Promise<string> {
  const core = await loadThatchCore();
  return core
    .cursorInstructions()
    .replace(/Cursor/g, "Pi")
    .replace(/AGENTS\.md/g, "the Pi system prompt");
}

export interface PiCommand {
  name: string;
  description: string;
  body: string;
}

/** The 6 shared action commands (opencode-only ones filtered out), MCP-spelled. */
export async function getCommandDefs(): Promise<PiCommand[]> {
  const core = await loadThatchCore();
  return core
    .actionDefs(core.mcpToolName)
    .filter((d) => !d.opencodeOnly)
    .map((d) => ({ name: d.name, description: d.description, body: d.body }));
}

/** Install thatch's skills into `dir` (idempotent). Returns the dir for resources_discover. */
export async function provisionSkills(dir: string): Promise<string> {
  const core = await loadThatchCore();
  core.installSkills(dir);
  return dir;
}

/** The task prompt handed to a background extraction child (PI_THATCH_EXTRACTION=background). */
export function piExtractionChildPrompt(count: number, sessionId: string): string {
  const plural = count === 1 ? "" : "s";
  return (
    `Extract durable facts from ${count} queued tool interaction${plural}. ` +
    `Call mcp__thatch__get_extraction_payload with session_id "${sessionId}" to retrieve them, ` +
    `run the thatch-fact-extractor skill, save durable facts with mcp__thatch__memory_remember, ` +
    `then call mcp__thatch__extraction_done with session_id "${sessionId}" when finished.`
  );
}
