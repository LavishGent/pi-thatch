import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  familiarizeText,
  formatNudges,
  isBunRuntime,
  loadProvisioning,
  loadStore,
  resolveConfig,
  ThatchSession,
} from "../src/thatch-core.ts";

// Seam smoke: proves the deep imports into thatch's non-exported internals
// resolve and still export the symbols we depend on. If a thatch upgrade moves
// these, this fails loudly instead of the extension silently going quiet.
test("loadProvisioning exposes the Node-safe thatch internals", async () => {
  const core = await loadProvisioning();
  expect(typeof core.claudeRecallNudge).toBe("function");
  expect(typeof core.predictionNudge).toBe("function");
  expect(typeof core.behaviorNudge).toBe("function");
  expect(typeof core.appendBatch).toBe("function");
  expect(typeof core.peekQueue).toBe("function");
  expect(typeof core.cursorInstructions).toBe("function");
  expect(typeof core.mcpToolName).toBe("function");
  expect(typeof core.actionDefs).toBe("function");
  expect(typeof core.installSkills).toBe("function");
  // The boundary stays honest: nothing Bun-only leaks into the Node-safe side.
  expect("ThatchDB" in core).toBe(false);
  expect("detectRepo" in core).toBe(false);
});

test("loadStore exposes the Bun-only thatch internals", async () => {
  expect(isBunRuntime()).toBe(true);
  const store = await loadStore();
  expect(typeof store.ThatchDB).toBe("function");
  expect(typeof store.repoPathCache).toBe("function");
  expect(typeof store.BgeEmbeddingModel).toBe("function");
  expect(typeof store.detectRepo).toBe("function");
});

test("concurrent loader calls share one load", async () => {
  const [a, b] = await Promise.all([loadProvisioning(), loadProvisioning()]);
  expect(a).toBe(b);
  const [c, d] = await Promise.all([loadStore(), loadStore()]);
  expect(c).toBe(d);
});

// Pi exposes thatch's tools as mcp__thatch__*; the methodology also teaches the
// bare names. thatch's opencode spellings (thatch_memory_recall, ...) do not
// exist in Pi, so a nudge naming them sends the model to a missing tool.
const prediction = {
  matcher_description: "choosing a test strategy",
  statement: "prefer integration tests",
  confidence: 0.8,
  evidence_count: 3,
};
const behavior = {
  matcher_description: "editing a large function",
  statement: "read it fully first",
  confidence: 0.7,
  evidence_count: 2,
};

test("formatNudges renders all three parts with Pi's tool names", async () => {
  const text = await formatNudges({
    matches: [{ label: "auth flow", score: 0.9 }],
    predictions: [prediction],
    behaviors: [behavior],
  });
  expect(text).not.toBeNull();
  const parts = text!.split("\n\n");
  expect(parts[0]).toContain("auth flow");
  expect(parts[0]).toContain("memory_recall(");
  expect(text).toContain("prefer integration tests");
  expect(text).toContain("mcp__thatch__prediction_query");
  expect(text).toContain("read it fully first");
  expect(text).toContain("mcp__thatch__behavior_list");
  expect(text).not.toMatch(/\bthatch_[a-z_]+/);
});

test("formatNudges skips empty parts and returns null when nothing fires", async () => {
  expect(await formatNudges({ matches: [], predictions: [], behaviors: [] })).toBeNull();
  const only = await formatNudges({ matches: [], predictions: [prediction], behaviors: [] });
  expect(only).toContain("User decision model");
  expect(only).not.toContain("relate to this prompt");
});

test("familiarizeText lists labels and names the Pi recall tool", () => {
  expect(familiarizeText([])).toBeNull();
  const one = familiarizeText(["conventions"]);
  expect(one).toContain('1 foundational memory exist');
  expect(one).toContain('"conventions"');
  expect(one).toContain("mcp__thatch__memory_recall");
  expect(familiarizeText(["a", "b"])).toContain("2 foundational memories");
});

test("resolveConfig mirrors thatch's env chain and defaults", () => {
  const cfg = resolveConfig("/proj", {
    HOME: "/home/x",
    THATCH_RECALL_THRESHOLD: "0.42",
  } as NodeJS.ProcessEnv);
  expect(cfg.projectDir).toBe("/proj");
  expect(cfg.dbPath).toBe("/home/x/.config/thatch/thatch.db");
  expect(cfg.modelName).toBe("Xenova/bge-small-en-v1.5");
  expect(cfg.recallThreshold).toBe(0.42);
  expect(cfg.predictionThreshold).toBe(0.6);
  expect(cfg.minPromptLen).toBe(10);
});

test("resolveConfig honors THATCH_PROJECT_DIR and THATCH_DB_PATH overrides", () => {
  const cfg = resolveConfig("/proj", {
    HOME: "/home/x",
    THATCH_PROJECT_DIR: "/pinned",
    THATCH_DB_PATH: "/custom/db.sqlite",
  } as NodeJS.ProcessEnv);
  expect(cfg.projectDir).toBe("/pinned");
  expect(cfg.dbPath).toBe("/custom/db.sqlite");
});

// Short prompts short-circuit before any embedding work (fast, no model load).
test("computeNudges returns null for a too-short prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-thatch-test-"));
  const session = await ThatchSession.create(dir, {
    HOME: dir,
    THATCH_DB_PATH: join(dir, "thatch.db"),
  } as NodeJS.ProcessEnv);
  try {
    expect(await session.computeNudges("hi")).toBeNull();
    // A fresh store yields no matches even for a long prompt.
    expect(await session.computeNudges("tell me about the authentication architecture here")).toBeNull();
    // Re-familiarization is silent on an empty store.
    expect(await session.familiarize()).toBeNull();
  } finally {
    session.dispose();
  }
}, 60_000);
