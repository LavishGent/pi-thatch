import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { importPatched, loadCommandsOnNode, loadExtractQueueOnNode } from "../src/node-shim.ts";

// The shim exists for Node, but its output is checked here under Bun, where
// thatch's own modules load natively and can serve as the reference.
const srcDir = dirname(createRequire(import.meta.url).resolve("@jeffober/thatch"));

test("patched commands.ts yields the same actions as thatch's own", async () => {
  const native = await import(join(srcDir, "commands.ts"));
  const patched = await loadCommandsOnNode(srcDir);
  expect(patched.actionDefs()).toEqual(native.actionDefs());
  expect(patched.actionDefs().map((d: { name: string }) => d.name)).toContain("bug-intake");
});

test("patched extract-queue.ts drains on the real [saved] marker only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-thatch-shim-test-"));
  process.env.THATCH_QUEUE_DIR = dir;
  try {
    const q = await loadExtractQueueOnNode(srcDir);
    const { MEMORY_SAVED_MARKER } = await import(join(srcDir, "tool-defs.ts"));
    const read = { tool_name: "read", tool_input: { path: "a" }, tool_response: "x" };
    q.appendBatch("s1", [read]);
    expect(q.peekQueue("s1")).toHaveLength(1);

    const remember = { tool_name: "mcp__thatch__memory_remember", tool_input: {} };
    q.appendBatch("s1", [{ ...remember, tool_response: "[held] near duplicate" }]);
    expect(q.peekQueue("s1")).toHaveLength(1);

    q.appendBatch("s1", [{ ...remember, tool_response: `${MEMORY_SAVED_MARKER} global :: label` }]);
    expect(q.peekQueue("s1")).toHaveLength(0);
  } finally {
    delete process.env.THATCH_QUEUE_DIR;
  }
});

test("a replacement that no longer matches throws instead of loading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-thatch-shim-test-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "m.ts"), "export const a = 1;\n");
  await expect(importPatched(dir, "m.ts", [{ find: "import.meta.dir", replace: '""' }])).rejects.toThrow(
    /expected text not found/,
  );
});

test("the temporary patched copy is removed after import", async () => {
  const before = readdirTmp();
  await loadCommandsOnNode(srcDir);
  expect(readdirTmp()).toEqual(before);
});

function readdirTmp(): string[] {
  return (require("node:fs").readdirSync(tmpdir()) as string[]).filter((n) => n.startsWith("pi-thatch-shim-")).sort();
}
