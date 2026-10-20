import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExtractionBuffer, piExtractionNudge, piExtractionChildPrompt } from "../src/thatch-core.ts";

beforeAll(() => {
  // Isolate the file-backed queue from the real cache dir.
  process.env.THATCH_QUEUE_DIR = mkdtempSync(join(tmpdir(), "pi-thatch-queue-"));
});

test("buffers ordinary tool interactions and filters thatch/meta tools", async () => {
  const buf = await ExtractionBuffer.create(randomUUID());
  expect(buf.count()).toBe(0);

  buf.buffer("read", { path: "src/auth.ts" }, "file contents");
  buf.buffer("bash", { command: "ls" }, "a\nb");
  expect(buf.count()).toBe(2);

  // thatch's own tools are filtered inside appendBatch (no self-echo).
  buf.buffer("mcp__thatch__memory_recall", { query: "x" }, "result");
  expect(buf.count()).toBe(2);
});

test("a memory_remember drains the queue (opencode drain-on-save)", async () => {
  const buf = await ExtractionBuffer.create(randomUUID());
  buf.buffer("read", { path: "a" }, "x");
  buf.buffer("grep", { pattern: "y" }, "z");
  expect(buf.count()).toBe(2);

  buf.buffer("mcp__thatch__memory_remember", { content: "a durable fact" }, "[saved]");
  expect(buf.count()).toBe(0);
});

test("queues are isolated per session id", async () => {
  const a = await ExtractionBuffer.create(randomUUID());
  const b = await ExtractionBuffer.create(randomUUID());
  a.buffer("read", { path: "a" }, "x");
  expect(a.count()).toBe(1);
  expect(b.count()).toBe(0);
});

test("extraction nudge names the tools and session id, and escalates", () => {
  const id = "sess-123";
  const soft = piExtractionNudge(3, 0, id);
  expect(soft).toContain("[thatch]");
  expect(soft).toContain("mcp__thatch__get_extraction_payload");
  expect(soft).toContain("mcp__thatch__extraction_done");
  expect(soft).toContain(id);
  expect(soft).toContain("3 tool interactions");

  const hard = piExtractionNudge(1, 3, id);
  expect(hard).toContain("IGNORING EXTRACTION");
  expect(hard).toContain("1 tool interaction");

  const child = piExtractionChildPrompt(2, id);
  expect(child).toContain("thatch-fact-extractor");
  expect(child).toContain(id);
});
