# pi-thatch architecture

How the extension brings thatch to Pi, end to end.

## The problem it solves

[thatch](https://github.com/sysread/thatch) is a persistent-memory +
methodology engine that ships as an OpenCode plugin and as an MCP server for
Claude Code / Cursor. Pi had no thatch integration. pi-thatch makes Pi a first-
class thatch host, so each Pi session inherits what prior sessions learned about
a repo instead of relearning it from scratch.

Two facts shaped the design:

1. **Pi loads extensions through jiti on every runtime**, and thatch's npm
   package ships raw TypeScript. So the extension can import thatch's internals
   *in-process* rather than shelling to a daemon, on Node or Bun. Only two
   thatch modules are Bun-coupled (`db.ts` via `bun:sqlite`, `git.ts` via Bun's
   `$`), and they are isolated behind their own loader.
2. **Pi event handlers get `ExtensionContext`, which has no `executeTool`.** So
   the ambient behaviors cannot call MCP tools; they must read thatch's store
   directly in-process. Writes still go through the MCP tools, keeping a single
   writer.

## Three concerns, three mechanisms

```
                       pi-thatch extension (Node or Bun, in Pi's process)
                       ┌──────────────────────────────────────────┐
  user installs  ───►  │  factory(pi):                             │
  one extension        │   registerMcpServer ─────────────► tools  │ ── bunx @jeffober/thatch mcp
                       │   registerCommand × 6 ────────────► /cmds  │    (subprocess; the one writer)
                       │   getMethodology ─┐                       │
                       │   provisionSkills │                       │
                       └───────────────────┼───────────────────────┘
                        before_agent_start ─┘  appendSystemPrompt (methodology)
                        resources_discover ──► skillPaths (36 skills)
                        context ───────────────► recall/prediction/behavior +
                                                 re-familiarization + extraction
                                                 nudge (ephemeral injection)
                        tool_result ──────────► buffer to extraction queue
                        session_start / _compact / agent_* / ui_prompt_start / _settled
```

- **Tools** come from the thatch MCP server, registered programmatically with
  `pi.registerMcpServer` (no `mcp.json` editing). Pi owns the subprocess,
  lifecycle, and the `mcp__thatch__*` tool pipeline. All memory **writes** flow
  here — one writer.
- **Methodology, commands, skills** are *provisioned* by the extension on load
  using thatch's own generators, so the user sets up nothing.
- **Ambient behaviors** are driven by Pi event hooks that read thatch's store
  in-process.

## The blast door (`src/thatch-core.ts`)

thatch's `package.json` `exports` expose only `.` and `./tui`, so its core
modules are not importable by bare specifier. This one module is the *only*
place that reaches thatch's non-exported internals:

- It resolves the package root from thatch's `.` entry
  (`require.resolve("@jeffober/thatch")` → `<root>/src/index.ts`).
- It imports the core files by absolute path. The published package ships raw
  TypeScript; Bun loads it directly and Pi's jiti loader transforms it on Node.
- Two independent, memoized loaders split the imports by runtime need:

  | Loader | thatch modules | Runtime | Backs |
  |---|---|---|---|
  | `loadProvisioning()` | `prompts.ts`, `commands.ts`, `skills.ts`, `extract-queue.ts` | Node + Bun | methodology, commands, skills, `ExtractionBuffer`, nudge formatters |
  | `loadStore()` | `db.ts`, `embeddings.ts`, `git.ts` | Bun only | `ThatchSession` (in-process recall, re-familiarization) |

  `loadStore()` refuses to import anything when `isBunRuntime()` is false. Each
  loader memoizes its in-flight promise so overlapping callers share one module
  evaluation; under jiti a second concurrent import can otherwise observe a
  half-initialized module. A rejected load is not cached.

Everything is pinned to `@jeffober/thatch@0.2.9` and guarded by
`tests/thatch-core.test.ts`, which asserts each loader's symbols still exist
(and that nothing Bun-only leaks into the provisioning side). If a thatch
upgrade moves them, that test fails loudly instead of the extension silently
going quiet. The module re-exports a small, typed facade (`ThatchSession`,
`ExtractionBuffer`, nudge/provisioning helpers) so the rest of the extension
never touches thatch directly.

## Provisioning (on extension load)

The factory is `async`; Pi awaits it before startup continues, so everything is
in place for the first session.

1. **MCP server** — `pi.registerMcpServer("thatch", { command: "bunx", args:
   ["@jeffober/thatch@0.2.9", "mcp"], exposure: "direct" })`. `direct` so the 29
   tools are declared to the model.
2. **Commands** — `getCommandDefs()` calls thatch's `actionDefs(mcpToolName)`,
   drops the OpenCode-only ones, and registers the remaining 6 with
   `pi.registerCommand`; each handler sends the action body (plus any argument as
   a `Focus:` line) via `pi.sendUserMessage`.
3. **Methodology** — `getMethodology()` renders thatch's `cursorInstructions()`
   remapped to Pi. A `before_agent_start` handler appends it to
   `systemPromptOptions.appendSystemPrompt`, guarded by a marker so it is added
   once and stays byte-identical across turns (prompt-cache safe).
4. **Skills** — `provisionSkills(cacheDir)` calls thatch's `installSkills` to
   write the 36 skills under `~/.cache/pi-thatch/skills` (idempotent); a
   `resources_discover` handler returns that path as `skillPaths`.

## Ambient behaviors

### Recall + re-familiarization (the "it remembers" feel) — Bun only

`ThatchSession` holds an in-process `ThatchDB` and a warm `BgeEmbeddingModel`,
built on `session_start` (repo detected → project + global stores). On Node,
`session_start` skips it with one debug line and the methodology's "recall at
session start" instruction carries the manual path; the sideband client planned
for Node parity is tracked in the README.

- **Recall nudge** (`context` hook, turn start): the user's prompt is embedded
  (`queryEmbed`) and run through `db.search` + `scorePredictionNudge` +
  `scoreBehaviorNudge` with thatch's thresholds (0.55 / 0.60 / 0.60). Matches
  are formatted by `formatNudges` with the formatters thatch's own MCP-host hook
  uses (`claudeRecallNudge`, and `predictionNudge` / `behaviorNudge` with
  `mcpToolName`), so the nudge names tools Pi actually exposes, and injected as
  an **ephemeral trailing context message**.
  `context` edits are not persisted, so the session transcript stays clean.
- **Re-familiarization** (`session_start`, `session_compact`): a standing query
  surfaces the project's foundational memories on the next turn, so the agent is
  oriented at startup and not amnesiac after a compaction.

Injection happens in `context` (not `before_agent_start`) because that event's
message edits are request-scoped and ephemeral — the right place for per-turn
context that must not pollute history.

### Fact extraction

- **Buffering** (`tool_result` hook): every tool result is fed to thatch's
  `appendBatch`, which filters meta/`mcp__thatch__*` tools and **self-drains the
  queue when it sees `memory_remember`** — reproducing OpenCode's drain-on-save,
  because Pi fires `tool_result` for MCP tool calls too. The queue is file-backed
  under `$XDG_CACHE_HOME/thatch/queue`, keyed by session id, and therefore shared
  with the MCP-server process. A result that lands while `session_start`'s build
  is still in flight waits for the buffer instead of being dropped.
- **`PI_THATCH_EXTRACTION`** chooses what happens with queued interactions:
  - `off` (default): buffer only; drains when the agent saves memories on its own.
  - `nudge`: inject a `[thatch]` extraction nudge at the next turn (escalating
    with a missed count) → the agent fetches the payload and saves. Spends
    main-context tokens (Claude/Cursor parity).
  - `background`: on `agent_settled`, spawn (`node:child_process`, detached)
    an off-context Pi child (`PI_THATCH_CHILD=1`, loop-guarded) to drain the
    queue — closest to OpenCode's child-session extraction. The launcher is
    `PI_THATCH_PI_BIN`, else `pi-bun` under Bun / `pi` under Node; a missing
    launcher is logged, never surfaced.

### Alerts (opt-in)

An `agent_start` → `tool_result` counter classifies a run as real work vs
bookkeeping. `ui_prompt_start` fires a "needs input" (pause) notification;
`agent_settled` after real work fires a "done" notification. macOS `osascript`
/ Linux `notify-send`.

## Process & data model

```
Pi (Node or Bun) process                  thatch MCP subprocess (Bun, via bunx)
├─ pi-thatch extension                     └─ serves mcp__thatch__* tools
│   ├─ ThatchDB (read, Bun) ───┐              ├─ ThatchDB (read+write)  ──┐
│   └─ ExtractionBuffer (write)│              └─ get_extraction_payload ──┤
│        to queue files        │                                         │
└──────────────────────────────┴── shared on disk ──────────────────────┘
        thatch.db (SQLite, WAL)   +   queue/*.jsonl
```

- The extension **reads** the DB in-process (recall) and **writes only the
  extraction queue** (buffering). All memory **writes** go through the MCP
  tools in the subprocess — one writer for `thatch.db`, avoiding contention.
- The extraction queue is the hand-off: the extension writes interactions; the
  agent (via `get_extraction_payload` / `extraction_done` in the subprocess)
  drains them.

## Degradation & safety

- Under the Node launcher the in-process store is skipped up front
  (`isBunRuntime()`), never attempted and caught: tools, methodology, commands,
  skills, extraction, and alerts all work; only the automatic recall nudge and
  re-familiarization are off. `tests/node-runtime.test.ts` proves this by
  running the extension under real `node` through jiti, the loader Pi uses.
- Under Bun, a store failure (for example a thatch upgrade breaking `db.ts`)
  is isolated to the store loader: provisioning and buffering still work.
- Every ambient path is wrapped best-effort: a model-load, search, or queue
  failure degrades to "no nudge," never an error to the user.
- Background extraction children set `PI_THATCH_CHILD=1` so they do not buffer,
  nudge, or spawn — no loops.

## File map

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension factory: provisioning + all event hooks |
| `src/thatch-core.ts` | Blast door (`loadProvisioning` / `loadStore`) + `ThatchSession`, `ExtractionBuffer`, nudge/provisioning helpers |
| `tests/thatch-core.test.ts` | Seam smoke (pins the thatch internals per loader), config, recall/familiarize |
| `tests/extraction.test.ts` | Buffering, meta-filter, drain-on-save, nudge text |
| `tests/extension.test.ts` | Provisioning + factory wiring + a simulated turn (Bun) |
| `tests/node-runtime.test.ts` + `tests/fixtures/node-load.mjs` | The same provisioning + a buffered turn under real Node via jiti |

## Key decisions

- **In-process over MCP for ambient logic** — forced by Pi's handler context
  lacking `executeTool`. Provisioning and buffering are plain Node code and run
  everywhere; the store read needs Bun. It also gives a warm model and all 39
  tool defs if needed later.
- **Two loaders, one runtime guard** — the Bun requirement is enforced in
  exactly one place (`loadStore`), before any Bun-only import, so Node users
  get everything that does not need the store and a thatch upgrade that breaks
  the store cannot take provisioning down with it.
- **Single writer** — only the MCP subprocess writes `thatch.db`; the extension
  reads and writes only the extraction queue. No two-writer contention.
- **Reuse thatch's own generators** — methodology, command bodies, skills, nudge
  formatters, and the extraction queue all come from thatch, so behavior matches
  upstream and tracks it on version bumps.
- **One blast door** — all coupling to thatch internals is isolated and tested,
  so the pinned-version risk has exactly one place to break and be fixed.
