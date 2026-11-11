# Changelog

## 0.1.0 (unreleased)

First public release.

- Installs as one Pi package and provisions everything automatically: the
  thatch MCP server (29 memory, prediction, behavior, and chat tools), the
  thatch methodology in the system prompt, 7 slash commands (`/reflect`,
  `/defrag`, `/hygiene`, `/refine`, `/self-review`, `/peer-review`, `/bug-intake`), and 41
  thatch skills.
- Automatic recall, prediction, and behavior nudges on every user turn, plus
  re-familiarization at session start and after compaction.
- Fact extraction: buffers tool interactions for thatch's extraction workflow,
  with `off`, `nudge`, and experimental `background` modes
  (`PI_THATCH_EXTRACTION`).
- Opt-in desktop alerts when Pi needs input or finishes work
  (`PI_THATCH_NOTIFY`).
- Runs on Pi's default Node launcher and under Bun. On Node, recall uses the
  thatch MCP server's sideband socket; under Bun it reads thatch's store
  in-process.
- Built on `@jeffober/thatch` 0.4.0, including the new `/bug-intake` command
  and four new skills. thatch 0.4.0's command and extraction-queue modules do
  not load on Node, so pi-thatch loads patched copies there (`src/node-shim.ts`,
  see ARCHITECTURE.md). The shim goes away once thatch fixes both modules.
