import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension must work for Pi users on the default Node launcher. `bun
// test` runs under Bun, so these spawn real `node` on a fixture that loads
// src/index.ts through jiti, the same loader (and pinned version) Pi uses for
// extensions, with thatch's real sideband server standing in for the MCP
// server's warm model.
const nodeBin = Bun.which("node");
const run = nodeBin ? test : test.skip;

interface Report {
  runtime: string;
  errors: string[];
  turns: Array<string | null>;
  mcpServers?: string[];
  commands?: string[];
  methodology?: boolean;
  skillInstalled?: boolean;
}

async function runFixture(preTurns: number): Promise<{ report: Report; stderr: string }> {
  const cache = mkdtempSync(join(tmpdir(), "pi-thatch-node-"));
  const proc = Bun.spawn([nodeBin!, join(import.meta.dir, "fixtures", "node-load.mjs")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: cache,
      XDG_CACHE_HOME: cache,
      THATCH_QUEUE_DIR: join(cache, "queue"),
      THATCH_DB_PATH: join(cache, "thatch.db"),
      PI_THATCH_EXTRACTION: "nudge",
      PI_THATCH_DEBUG: "1",
      PRE_TURNS: String(preTurns),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  const report = JSON.parse(stdout) as Report;
  expect(report.runtime).toBe("node");
  expect(report.errors).toEqual([]);
  return { report, stderr };
}

const FAMILIARIZE = "foundational memories exist";
const RECALL = "relate to this prompt";
const EXTRACTION = "queued for fact extraction";

run("under Node: provisioning, extraction, re-familiarization, and recall all work", async () => {
  const { report, stderr } = await runFixture(0);

  expect(report.mcpServers).toEqual(["thatch"]);
  expect(report.commands).toEqual(["defrag", "hygiene", "peer-review", "refine", "reflect", "self-review"]);
  expect(report.methodology).toBe(true);
  expect(report.skillInstalled).toBe(true);

  // One turn with the sideband up: familiarize, recall, and the extraction
  // nudge for the tool result buffered right after session_start, in order.
  const [only] = report.turns;
  expect(only).toBeTruthy();
  const famAt = only!.indexOf(FAMILIARIZE);
  const recallAt = only!.indexOf(RECALL);
  const extractAt = only!.indexOf(EXTRACTION);
  expect(famAt).toBeGreaterThanOrEqual(0);
  expect(recallAt).toBeGreaterThan(famAt);
  expect(extractAt).toBeGreaterThan(recallAt);
  expect(only).toContain('"architecture overview"');
  expect(only).toContain("memory_recall(");

  expect(stderr).toContain("recall via the thatch sideband");
  expect(stderr).not.toContain("bun:sqlite");
  expect(stderr).not.toContain("failed");
}, 60_000);

run("under Node: re-familiarization retries until the sideband comes up", async () => {
  const { report } = await runFixture(1);
  const [before, after] = report.turns;
  // Server down: no familiarize or recall yet, but extraction still nudges.
  expect(before).toContain(EXTRACTION);
  expect(before).not.toContain(FAMILIARIZE);
  expect(before).not.toContain(RECALL);
  // Server up: the pending familiarize is retried and recall fires.
  expect(after).toContain(FAMILIARIZE);
  expect(after).toContain(RECALL);
}, 60_000);

run("under Node: re-familiarization gives up after five unavailable attempts", async () => {
  const { report } = await runFixture(5);
  const last = report.turns[report.turns.length - 1];
  expect(report.turns).toHaveLength(6);
  // Recall is per prompt and still fires; the familiarize budget is spent.
  expect(last).toContain(RECALL);
  expect(last).not.toContain(FAMILIARIZE);
}, 60_000);
