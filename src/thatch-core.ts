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

interface ThatchCore {
  ThatchDB: new (dbPath: string, opts?: unknown) => ThatchDBLike;
  repoPathCache: (db: ThatchDBLike) => unknown;
  BgeEmbeddingModel: new (modelName: string) => EmbeddingModel;
  detectRepo: (projectDir: string, cache: unknown) => Promise<string>;
  recallNudge: (matches: NudgeMatch[]) => string;
  predictionNudge: (items: unknown[]) => string;
  behaviorNudge: (items: unknown[]) => string;
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
  const [db, embeddings, git, prompts] = await Promise.all([
    import(join(src, "db.ts")),
    import(join(src, "embeddings.ts")),
    import(join(src, "git.ts")),
    import(join(src, "prompts.ts")),
  ]);
  cached = {
    ThatchDB: db.ThatchDB,
    repoPathCache: db.repoPathCache,
    BgeEmbeddingModel: embeddings.BgeEmbeddingModel,
    detectRepo: git.detectRepo,
    recallNudge: prompts.recallNudge,
    predictionNudge: prompts.predictionNudge,
    behaviorNudge: prompts.behaviorNudge,
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
    const stores = repo === "global" ? ["global"] : [repo, "global"];
    return new ThatchSession(core, db, model, stores, cfg);
  }

  /**
   * Proactive foundational recall, injected once at session start and again
   * after a compaction (mirrors opencode's session-start reminder and
   * post-compaction re-familiarization). Returns null on a fresh store.
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

  /**
   * The prompt-aware recall + prediction + behavior nudge, mirroring thatch's
   * opencode runtime. Returns the combined nudge text, or null when nothing
   * fires. Best-effort: each sub-nudge is independently guarded.
   */
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
