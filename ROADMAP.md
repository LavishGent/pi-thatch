# Roadmap

Where pi-thatch is headed after the first release, and the decisions behind
it. Current behavior is described in [README.md](README.md) and
[ARCHITECTURE.md](ARCHITECTURE.md).

## Priorities, in order

1. **Publish to npm and the Pi package catalog** (`pi install npm:pi-thatch`).
2. **Fix the shared sideband socket** (below), preferably upstream in thatch.
3. **One recall path:** the sideband on both runtimes; retire the in-process
   store.
4. **Upstream a Pi host into thatch**, so thatch owns provisioning and
   pi-thatch stops importing thatch's non-exported internals. Then get
   pi-thatch linked from thatch's documentation.

## Decision: which recall path to keep

Status: **decided (target state), blocked on the socket fix.** Recorded
after measuring thatch 0.2.9 on macOS.

Today recall has two implementations: `ThatchSession` reads thatch's store
in-process under Bun, and `SidebandRecall` asks the thatch MCP server's warm
model over its Unix socket (Node, and the Bun fallback).

### What was measured

- **In-process recall loads a second copy of the embedding model.** Loading
  thatch's model adds about **1.3 GB** of resident memory and about **4.3 s**
  to the first embed (warm embeds take about 12 ms). The thatch MCP server Pi
  runs for every session already holds one copy (about 1.6 GB resident).
- **Concurrent sessions are the normal case.** Each Pi session spawns its own
  thatch MCP server, and every server for one database binds the **same**
  socket path. Two servers bound to one path were observed in ordinary use.
- **The shared path breaks when its owner exits.** The newest server owns the
  path; when it exits, `SidebandServer.stop()` deletes it, and the other
  servers' listeners become unreachable. Sideband recall stops for the
  remaining sessions until one of them restarts its server.
- **Any live server can answer any session.** All servers read the same
  `thatch.db`, so which server owns the path does not matter, only that the
  path exists.

### Options considered

| Option | Verdict |
|---|---|
| A. Keep both paths (current) | Interim only: two model copies per Bun session, two code paths, and the in-process path depends on thatch's most coupled internals (`db.ts`, `git.ts`, embeddings). |
| B. Sideband everywhere, as is | Rejected: Bun sessions would inherit the shared-socket breakage. |
| **C. Sideband everywhere, socket fixed** | **Chosen.** One code path, about 1.3 GB saved per Bun session, identical behavior on both runtimes, and the same channel thatch uses for Claude Code and Cursor. |
| D. In-process on Node too (a `node:sqlite` stand-in for `bun:sqlite`) | Rejected: deeper coupling to thatch internals and still a second model copy. |

### The socket fix

1. **Preferred, upstream in thatch:** each `SidebandServer` periodically
   checks that its socket path exists and re-listens when it does not. A small
   change that also fixes thatch's Claude Code and Cursor hosts.
2. **Fallback, in pi-thatch:** when the socket stays missing across turns,
   restart this session's thatch server (`pi.unregisterMcpServer` /
   `pi.registerMcpServer`), which rebinds the path. Costs a model reload and
   interrupts an in-flight thatch tool call, so it is a bridge, not the fix.

### Sequence once the fix exists

1. Warm the sideband at session start so a cold server does not miss turn-1
   recall. First verify that a pending request cannot hold a `pi -p` process
   open (thatch's client timer is not `unref`'d).
2. Make the sideband the default under Bun; keep the in-process store behind
   an environment variable for one release.
3. Remove the in-process store and the Bun-only loader (`loadStore`).

## Proposals for thatch

To raise with thatch's maintainer once pi-thatch is published:

- Sideband self-repair (above).
- A supported surface for the methodology text (for example a
  `thatch instructions --host <name>` command, or MCP `initialize`
  instructions), replacing pi-thatch's deep import of `prompts.ts`.
- A stable `./core` export, or a first-party Pi host (`thatch setup --pi`),
  so integrations stop depending on non-exported modules.
- A link to pi-thatch from thatch's documentation.

## Other open items

- Cross-session chat: auto-register identity and wake on unread mail.
- Background extraction hardening: tie the queue id to Pi's session id
  (survives resume); integration-test the child loop.
- Extraction feedback: report "new: N, updated: M" after a run.
- Conversation search and watchers (OpenCode-only in thatch today).
- Launch the MCP server from the installed `@jeffober/thatch` dependency
  instead of `bunx`, so the first run needs no network fetch and the server
  version always matches the extension's.
