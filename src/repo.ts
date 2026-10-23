/**
 * Store detection for Node: which thatch store a directory's memories live in.
 *
 * A port of thatch's `detectRepo` / `parseGitUrl` (src/git.ts in
 * @jeffober/thatch 0.2.9). thatch's module imports Bun's `$` at the top, so it
 * cannot load on Node; this version runs git through node:child_process
 * instead. tests/repo.test.ts checks it against thatch's own functions on
 * every directory shape, so a drift in either fails loudly.
 * thatch is MIT-licensed; its notice is in THIRD_PARTY_NOTICES.md.
 *
 * Deliberately omitted: thatch's repo-path cache. It recovers the identity of
 * a deleted worktree; a Pi session's cwd exists when the session starts, which
 * is the only time this runs.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";

const GIT_TIMEOUT_MS = 5000;

const URL_PATTERNS: Array<{ re: RegExp; fn: (m: RegExpMatchArray) => string }> = [
  // git@github.com:owner/repo
  { re: /^git@([^:]+):(.+)\/(.+)$/, fn: (m) => `${m[2]}/${m[3]}` },
  // https://github.com/owner/repo
  { re: /^https?:\/\/[^/]+\/(.+)\/(.+)$/, fn: (m) => `${m[1]}/${m[2]}` },
  // ssh://git@github.com/owner/repo
  { re: /^ssh:\/\/git@[^/]+\/(.+)\/(.+)$/, fn: (m) => `${m[1]}/${m[2]}` },
  // git://github.com/owner/repo
  { re: /^git:\/\/[^/]+\/(.+)\/(.+)$/, fn: (m) => `${m[1]}/${m[2]}` },
];

/** `owner/repo` from a git remote URL, or null for an unrecognized format. */
export function parseGitUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  for (const pattern of URL_PATTERNS) {
    const m = cleaned.match(pattern.re);
    if (m) return pattern.fn(m);
  }
  return null;
}

/** git's stdout, or null on a non-zero exit, a spawn failure, or a timeout. */
function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

function pathExists(dir: string): boolean {
  try {
    statSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * The repository identity for `dir`, in thatch's order:
 *   1. `owner/repo` parsed from the `origin` remote;
 *   2. the main checkout's basename (worktree-safe: the git common dir lives
 *      in the main checkout);
 *   3. "unknown" when the directory is gone, else the directory's basename.
 * Callers map "unknown" to the global store.
 */
export async function detectRepoNode(dir: string): Promise<string> {
  const remote = await git(["remote", "get-url", "origin"], dir);
  if (remote !== null) {
    const parsed = parseGitUrl(remote);
    if (parsed) return parsed;
  }

  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  if (common !== null) {
    const d = common.trim();
    if (d.endsWith("/.git")) {
      const name = basename(d.slice(0, -"/.git".length));
      if (name !== "" && name !== "unknown") return name;
    }
  }

  if (!pathExists(dir)) return "unknown";
  return dir.split("/").pop() || "unknown";
}
