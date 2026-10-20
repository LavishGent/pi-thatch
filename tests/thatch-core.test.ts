import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadThatchCore, resolveConfig, ThatchSession } from "../src/thatch-core.ts";

// Seam smoke: proves the deep imports into thatch's non-exported internals
// resolve and still export the symbols we depend on. If a thatch upgrade moves
// these, this fails loudly instead of the extension silently going quiet.
test("loadThatchCore exposes the expected thatch internals", async () => {
  const core = await loadThatchCore();
  expect(typeof core.ThatchDB).toBe("function");
  expect(typeof core.BgeEmbeddingModel).toBe("function");
  expect(typeof core.detectRepo).toBe("function");
  expect(typeof core.repoPathCache).toBe("function");
  expect(typeof core.recallNudge).toBe("function");
  expect(typeof core.predictionNudge).toBe("function");
  expect(typeof core.behaviorNudge).toBe("function");
});

test("recallNudge renders thatch's nudge text", async () => {
  const core = await loadThatchCore();
  const text = core.recallNudge([{ label: "auth flow", score: 0.9 }]);
  expect(text).toContain("[thatch]");
  expect(text).toContain("memory");
  expect(text).toContain("auth flow");
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
