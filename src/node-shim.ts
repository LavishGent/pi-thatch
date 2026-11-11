/**
 * Node-only loader for the two thatch modules that cannot load on Node as
 * published in 0.4.0. Used by thatch-core.ts and nowhere else.
 *
 *   - `commands.ts` calls `import.meta.dir`, which only Bun defines. On Node
 *     the module throws while loading.
 *   - `extract-queue.ts` imports one string constant (`MEMORY_SAVED_MARKER`)
 *     from `tool-defs.ts`. That file imports `session-db.ts`, which imports
 *     `bun:sqlite`, so loading the queue fails on Node.
 *
 * Instead of copying thatch's logic, this reads thatch's own source, replaces
 * only those two Bun-only pieces, and imports the result. Behavior always
 * matches the installed thatch version. If an upgrade changes the text we
 * replace, the loader throws a clear error (and tests/node-shim.test.ts fails)
 * rather than loading something half-patched.
 *
 * The patched copy is written to a private temporary directory, imported, and
 * deleted. Relative imports in it are rewritten to absolute paths so they
 * still resolve to thatch's real files.
 *
 * Remove this file once thatch ships Node-safe versions of both modules.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Replacement {
  /** Exact text that must appear in the source. */
  find: string;
  /** What to put there. */
  replace: string;
}

/** Point every relative `from "./x"` at its absolute location in thatch. */
function absolutizeImports(source: string, fromDir: string): string {
  return source.replace(/(\bfrom\s+)(["'])(\.\.?\/[^"']+)\2/g, (_m, kw: string, quote: string, spec: string) => {
    return `${kw}${quote}${resolve(fromDir, spec)}${quote}`;
  });
}

/**
 * Import `<srcDir>/<file>` with the given text replacements applied.
 * Every `find` must occur in the source; a missing one throws.
 */
export async function importPatched(srcDir: string, file: string, replacements: Replacement[]): Promise<any> {
  const path = join(srcDir, file);
  let source = readFileSync(path, "utf8");
  for (const { find, replace } of replacements) {
    if (!source.includes(find)) {
      throw new Error(
        `pi-thatch Node shim: expected text not found in thatch ${file} (${JSON.stringify(find)}). ` +
          `This pi-thatch release was written for a different thatch version.`,
      );
    }
    source = source.split(find).join(replace);
  }
  source = absolutizeImports(source, dirname(path));

  const dir = mkdtempSync(join(tmpdir(), "pi-thatch-shim-"));
  try {
    const patched = join(dir, file);
    writeFileSync(patched, source, { mode: 0o600 });
    return await import(patched);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The command loader: `import.meta.dir` becomes the real source directory. */
export function loadCommandsOnNode(srcDir: string): Promise<any> {
  return importPatched(srcDir, "commands.ts", [{ find: "import.meta.dir", replace: JSON.stringify(srcDir) }]);
}

/**
 * The extraction-queue loader: the marker import becomes a local constant.
 * The value is read from thatch's own `tool-defs.ts` so it cannot drift.
 */
export function loadExtractQueueOnNode(srcDir: string): Promise<any> {
  const toolDefs = readFileSync(join(srcDir, "tool-defs.ts"), "utf8");
  const match = toolDefs.match(/^export const MEMORY_SAVED_MARKER = ("[^"\n]*");$/m);
  if (!match) {
    throw new Error("pi-thatch Node shim: MEMORY_SAVED_MARKER not found in thatch tool-defs.ts");
  }
  return importPatched(srcDir, "extract-queue.ts", [
    {
      find: 'import { MEMORY_SAVED_MARKER } from "./tool-defs";',
      replace: `const MEMORY_SAVED_MARKER = ${match[1]};`,
    },
  ]);
}
