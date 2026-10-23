import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { detectRepoNode, parseGitUrl } from "../src/repo.ts";

// Parity with thatch's own store detection (git.ts), which needs Bun's `$` and
// so cannot load on Node. The store name picks which memories recall searches,
// so the Node port must agree with thatch on every directory shape. thatch's
// module is imported here directly (Bun test only) as the oracle.
const require = createRequire(import.meta.url);
const thatchGit = await import(join(dirname(require.resolve("@jeffober/thatch")), "git.ts"));

const urls = [
  "git@github.com:owner/repo.git",
  "git@github.com:owner/repo",
  "git@gitlab.example.com:group/sub/repo.git",
  "https://github.com/owner/repo.git",
  "https://github.com/owner/repo/",
  "http://host/owner/repo",
  "https://gitlab.com/group/sub/repo.git",
  "ssh://git@github.com/owner/repo.git",
  "git://github.com/owner/repo",
  "  https://github.com/owner/repo.git  \n",
  "/local/path/to/repo",
  "file:///srv/repo.git",
  "",
];

test("parseGitUrl matches thatch on every URL shape", () => {
  for (const url of urls) {
    expect({ url, slug: parseGitUrl(url) }).toEqual({ url, slug: thatchGit.parseGitUrl(url) });
  }
});

let root: string;
const dirs: Record<string, string> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-thatch-repo-"));
  const git = (cwd: string) => $.cwd(cwd);

  dirs.withRemote = join(root, "with-remote");
  mkdirSync(dirs.withRemote);
  await git(dirs.withRemote)`git init -q`.quiet();
  await git(dirs.withRemote)`git remote add origin git@github.com:acme/widgets.git`.quiet();

  dirs.noRemote = join(root, "no-remote");
  mkdirSync(dirs.noRemote);
  await git(dirs.noRemote)`git init -q`.quiet();
  await git(dirs.noRemote)`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.quiet();

  // A linked worktree of the no-remote repo: identity is the MAIN checkout's.
  dirs.worktree = join(root, "linked-wt");
  await git(dirs.noRemote)`git worktree add -q -b wt ${dirs.worktree}`.quiet();

  dirs.subdir = join(dirs.withRemote, "src", "deep");
  mkdirSync(dirs.subdir, { recursive: true });

  dirs.plain = join(root, "not-a-repo");
  mkdirSync(dirs.plain);

  dirs.missing = join(root, "does-not-exist");
  dirs.thisRepo = join(import.meta.dir, "..");
});

test("detectRepoNode matches thatch's detectRepo on every directory shape", async () => {
  for (const [name, dir] of Object.entries(dirs)) {
    const ours = await detectRepoNode(dir);
    const theirs = await thatchGit.detectRepo(dir);
    expect({ name, store: ours }).toEqual({ name, store: theirs });
  }
  // Spot-check the expected identities, not just agreement.
  expect(await detectRepoNode(dirs.withRemote!)).toBe("acme/widgets");
  expect(await detectRepoNode(dirs.subdir!)).toBe("acme/widgets");
  expect(await detectRepoNode(dirs.noRemote!)).toBe("no-remote");
  expect(await detectRepoNode(dirs.worktree!)).toBe("no-remote");
  expect(await detectRepoNode(dirs.plain!)).toBe("not-a-repo");
  expect(await detectRepoNode(dirs.missing!)).toBe("unknown");
}, 30_000);
