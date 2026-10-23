import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension must work for Pi users on the default Node launcher: tools,
// methodology, commands, skills, and extraction buffering (the in-process
// store stays Bun-only until the sideband client lands). `bun test` runs under
// Bun, so this spawns real `node` on a fixture that loads src/index.ts through
// jiti, the same loader (and pinned version) Pi uses for extensions.
const nodeBin = Bun.which("node");
const run = nodeBin ? test : test.skip;

interface Report {
  runtime: string;
  errors: string[];
  mcpServers?: string[];
  commands?: string[];
  methodology?: boolean;
  skillsDir?: string | null;
  skillInstalled?: boolean;
  injected?: string | null;
}

run("under Node: provisioning and extraction buffering work, store is skipped cleanly", async () => {
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

  // Provisioning: everything but the in-process store.
  expect(report.mcpServers).toEqual(["thatch"]);
  expect(report.commands).toEqual(["defrag", "hygiene", "peer-review", "refine", "reflect", "self-review"]);
  expect(report.methodology).toBe(true);
  expect(report.skillInstalled).toBe(true);

  // Extraction buffering needs no store: the buffered tool_result surfaces as
  // the extraction nudge on the next user turn.
  expect(report.injected).toContain("queued for fact extraction");
  expect(report.injected).toContain("mcp__thatch__get_extraction_payload");

  // The store was skipped deliberately (one debug line), not by crashing.
  expect(stderr).toContain("in-process store skipped");
  expect(stderr).not.toContain("bun:sqlite");
  expect(stderr).not.toContain("failed");
}, 60_000);
