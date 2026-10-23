# pi-thatch

Persistent cross-session memory and an operational methodology for the
[Pi](https://pi.dev) coding agent, powered by
[thatch](https://github.com/sysread/thatch) — with **parity to thatch's
OpenCode plugin**.

Install one extension. It provisions everything automatically — memory tools,
methodology, slash commands, skills, and the ambient "it remembers on its own"
behaviors. You never edit a config file, and you never need to know what thatch
is.

> Runs on Pi's default **Node** launcher or under **Bun**. Under Bun the recall
> nudge additionally loads thatch's store and embedding model in-process; there
> is no separate daemon either way.

## Install

```bash
pi install github.com/LavishGent/pi-thatch     # or a local path
```

That's it. On first load the extension:

- registers the thatch **MCP server** (the 29 memory/prediction/behavior/chat
  tools, declared to the model);
- appends the thatch **methodology** to the system prompt;
- registers the 6 **slash commands** (`/reflect`, `/defrag`, `/hygiene`,
  `/refine`, `/self-review`, `/peer-review`);
- installs thatch's **skills** into a cache dir and offers them to the session.

### Requirements

- `bun` and `bunx` on PATH (the thatch MCP server is a Bun program; Pi spawns
  it with `bunx`). Pi itself may run on Node or Bun.
- **Optional: Pi launched under Bun** for the automatic recall nudge and
  re-familiarization, which read thatch's store in-process via `bun:sqlite`.
  Use a `pi-bun` wrapper: `exec bun "$(command -v pi-launcher)" "$@"`.
- First recall downloads thatch's embedding model once (~150 MB, cached
  per-user; skipped if already present from another thatch host).

### Runtime matrix

| Capability | Node launcher | Bun launcher |
|---|---|---|
| Memory tools (MCP), methodology, slash commands, skills | yes | yes |
| Fact extraction (`off` / `nudge` / `background`) | yes | yes |
| Desktop alerts | yes | yes |
| Automatic recall / prediction / behavior nudge | no (the methodology instructs manual recall) | yes |
| Session-start / post-compaction re-familiarization | no | yes |

Node parity for the last two rows is tracked below (sideband client).

## What you get

| Capability | How |
|---|---|
| **Memory tools** | `mcp__thatch__*` — remember/recall/list/show/forget, stores, dedup, predictions, behaviors, config, notify, chat (29 tools) |
| **Methodology** | thatch's "# Persistence" guidance appended to the system prompt: recall at session start, save durable findings, treat memories as pointers to verify |
| **Recall nudge** (Bun) | at each turn the prompt is embedded in-process and matched against your memories; relevant ones (plus predictions/behaviors) are injected automatically |
| **Re-familiarization** (Bun) | at session start and after every compaction, foundational memories are surfaced so the agent is never amnesiac |
| **Fact extraction** | tool interactions are buffered; the agent is reminded (or a background child is spawned) to distil durable facts into memory |
| **Slash commands** | `/reflect` `/defrag` `/hygiene` `/refine` `/self-review` `/peer-review` |
| **Skills** | 36 thatch skills (code review, archaeology, memory workflows, writing) |
| **Alerts** | opt-in desktop notification on pause (needs input) and done (real work) |

## Configuration (env)

Everything works with no configuration. Optional knobs:

| Var | Default | Effect |
|---|---|---|
| `PI_THATCH_EXTRACTION` | `off` | `off` \| `nudge` \| `background` — proactive fact extraction |
| `PI_THATCH_NOTIFY` | unset | `1` enables pause/done desktop notifications |
| `PI_THATCH_PI_BIN` | `pi-bun` under Bun, `pi` under Node | launcher used for `background` extraction children |
| `PI_THATCH_DEBUG` | unset | `1` logs diagnostics to stderr |
| `THATCH_DB_PATH` | `$XDG_CONFIG_HOME/thatch/thatch.db` | store location |
| `THATCH_MODEL` | `Xenova/bge-small-en-v1.5` | embedding model |
| `THATCH_RECALL_THRESHOLD` / `_PREDICTION_` / `_BEHAVIOR_` | `0.55` / `0.60` / `0.60` | nudge cutoffs |

To turn on proactive extraction: `export PI_THATCH_EXTRACTION=nudge`.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full breakdown. In short: a thin
Pi extension reuses thatch's internals in-process through one "blast door"
module, provisions the user-facing pieces via Pi's extension APIs, and drives
the ambient behaviors from Pi's event hooks.

## Development

```bash
bun install
bun test           # seam smoke, provisioning, extraction, factory wiring,
                   # plus a real-Node run of the extension through Pi's loader (jiti)
bunx tsc --noEmit  # typecheck
```

## Status

**Done**
- Auto-provisioning: MCP server, methodology, 6 commands, 36 skills — zero manual setup.
- Runs on the default Node launcher: everything except the in-process recall nudge.
- Recall / prediction / behavior nudge (in-process, Bun).
- Session-start + post-compaction re-familiarization (Bun).
- Fact extraction: buffering + drain-on-save + `nudge` mode + experimental `background` mode.
- Pause/done desktop alerts (opt-in).
- Verified end-to-end in real Pi under Bun; Node path verified through Pi's extension loader in tests.

**Not yet (tracked for full parity)**
- **Node: automatic recall nudge + re-familiarization** via thatch's sideband
  socket (the channel Claude Code and Cursor use), so Node users get parity
  without `bun:sqlite`.
- **Cross-session chat**: auto-register identity + wake on unread mail (needs
  identity reconciliation with the MCP-server process).
- **Background extraction hardening**: tie the queue id to Pi's session id
  (survive resume); integration-test the child loop.
- **Extraction feedback**: surface "new: N, updated: M" after a run.
- **Conversation search** and **watchers** (OpenCode-only; reimplement against
  Pi's session store / `gh`).
- **Upstream** a `pi` host + `thatch setup --pi` so thatch owns provisioning and
  the deep-import coupling retires.

## License

MIT
