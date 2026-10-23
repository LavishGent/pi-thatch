import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { SidebandRecall } from "../src/thatch-core.ts";

// SidebandRecall is the Node recall path: it asks the thatch MCP server's
// warm model over thatch's sideband socket. These tests run thatch's real
// SidebandServer (imported directly as the counterpart) on a temp socket with
// a fake model and DB, so the client, protocol, and server are all genuine.
const require = createRequire(import.meta.url);
const thatchSrc = dirname(require.resolve("@jeffober/thatch"));
const sideband = await import(join(thatchSrc, "sideband.ts"));

interface Call {
  method: string;
  stores: string[];
  threshold: number;
  limit: number;
}

const calls: Call[] = [];
let rows: Array<{ label: string; store: string; _score: number }> = [];
let predictions: unknown[] = [];
let behaviors: unknown[] = [];

const fakeModel = { queryEmbed: async () => new Float32Array([1, 0, 0]) };
const fakeDb = {
  search(stores: string[], _e: Float32Array, opts: { limit: number }) {
    calls.push({ method: "match", stores, threshold: NaN, limit: opts.limit });
    return rows.slice(0, opts.limit);
  },
  scorePredictionNudge(stores: string[], _e: Float32Array, threshold: number, limit: number) {
    calls.push({ method: "predictions", stores, threshold, limit });
    return predictions;
  },
  scoreBehaviorNudge(stores: string[], _e: Float32Array, threshold: number, limit: number) {
    calls.push({ method: "behaviors", stores, threshold, limit });
    return behaviors;
  },
};

let root: string;
let projectDir: string;
let env: NodeJS.ProcessEnv;
let server: { start(): void; stop(): void };

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(10);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-thatch-sb-"));
  projectDir = join(root, "proj");
  mkdirSync(projectDir);
  await $.cwd(projectDir)`git init -q`.quiet();
  await $.cwd(projectDir)`git remote add origin https://github.com/acme/widgets.git`.quiet();
  env = { HOME: root, THATCH_DB_PATH: join(root, "thatch.db") } as NodeJS.ProcessEnv;
  const sock = sideband.sidebandSocketPath(env.THATCH_DB_PATH!);
  server = new sideband.SidebandServer(sock, fakeModel, fakeDb);
  server.start();
  await waitFor(sock);
});

afterAll(() => server.stop());

function reset() {
  calls.length = 0;
  rows = [];
  predictions = [];
  behaviors = [];
}

test("computeNudges asks the sideband and formats all three parts", async () => {
  reset();
  rows = [
    { label: "auth flow", store: "acme/widgets", _score: 0.91 },
    { label: "too weak", store: "global", _score: 0.4 },
  ];
  predictions = [
    { matcher_description: "picking tests", statement: "prefer integration tests", confidence: 0.8, evidence_count: 3 },
  ];
  behaviors = [
    { matcher_description: "big function", statement: "read it fully first", confidence: 0.7, evidence_count: 2 },
  ];
  const recall = await SidebandRecall.create(projectDir, env);
  expect(recall.stores).toEqual(["acme/widgets", "global"]);

  const text = await recall.computeNudges("how does the authentication flow work here?");
  expect(text).toContain('"auth flow"');
  expect(text).not.toContain("too weak"); // below the 0.55 recall threshold
  expect(text).toContain("prefer integration tests");
  expect(text).toContain("read it fully first");
  expect(text).toContain("mcp__thatch__prediction_query");

  // Same stores, thresholds, and limits as the in-process path.
  const byMethod = Object.fromEntries(calls.map((c) => [c.method, c]));
  expect(byMethod.match).toMatchObject({ stores: ["acme/widgets", "global"], limit: 5 });
  expect(byMethod.predictions).toMatchObject({ threshold: 0.6, limit: 5 });
  expect(byMethod.behaviors).toMatchObject({ threshold: 0.6, limit: 5 });
});

test("computeNudges returns null when nothing matches, and skips short prompts", async () => {
  reset();
  const recall = await SidebandRecall.create(projectDir, env);
  expect(await recall.computeNudges("tell me about the architecture of this project")).toBeNull();
  calls.length = 0;
  expect(await recall.computeNudges("hi")).toBeNull();
  expect(calls).toEqual([]); // no request for a too-short prompt
});

test("familiarize keeps the top five foundational memories above 0.3", async () => {
  reset();
  rows = [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.2].map((s, i) => ({ label: `m${i}`, store: "global", _score: s }));
  const recall = await SidebandRecall.create(projectDir, env);
  const res = await recall.familiarize();
  expect(res.status).toBe("ok");
  const text = res.status === "ok" ? res.text : null;
  expect(text).toContain("5 foundational memories");
  expect(text).toContain('"m0", "m1", "m2", "m3", "m4"');
  expect(text).not.toContain('"m5"');
  expect(calls[0]).toMatchObject({ method: "match", limit: 6 });
});

test("familiarize is ok/null on an empty store", async () => {
  reset();
  const recall = await SidebandRecall.create(projectDir, env);
  expect(await recall.familiarize()).toEqual({ status: "ok", text: null });
});

test("no server: familiarize is unavailable and computeNudges is null, fast", async () => {
  const lonely = { HOME: root, THATCH_DB_PATH: join(root, "no-server.db") } as NodeJS.ProcessEnv;
  const recall = await SidebandRecall.create(projectDir, lonely);
  const t0 = Date.now();
  expect(await recall.familiarize()).toEqual({ status: "unavailable" });
  expect(await recall.computeNudges("tell me about the architecture of this project")).toBeNull();
  expect(Date.now() - t0).toBeLessThan(1000); // ENOENT fails immediately
});

test("a server that never answers times out to unavailable / null", async () => {
  const stuckEnv = { HOME: root, THATCH_DB_PATH: join(root, "stuck.db") } as NodeJS.ProcessEnv;
  const sock = sideband.sidebandSocketPath(stuckEnv.THATCH_DB_PATH!);
  const stuck: Server = createServer(() => {
    /* accept and never reply */
  });
  stuck.listen(sock);
  await waitFor(sock);
  try {
    const recall = await SidebandRecall.create(projectDir, stuckEnv, { timeoutMs: 150 });
    const t0 = Date.now();
    expect(await recall.familiarize()).toEqual({ status: "unavailable" });
    expect(await recall.computeNudges("tell me about the architecture of this project")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
  } finally {
    stuck.close();
  }
});

test("a directory with no repo identity searches only the global store", async () => {
  const recall = await SidebandRecall.create(join(root, "missing-dir"), env);
  expect(recall.stores).toEqual(["global"]);
});
