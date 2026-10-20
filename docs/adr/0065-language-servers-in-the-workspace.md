# 0065. Language servers in the workspace

- **Status**: Accepted (Epic 52). Supersedes the language-service part of ADR 0015 (its decision to leave out IntelliSense); the rest of 0015 stands.
- **Date**: 2026-10-20
- **References**: SPEC.md sections 13.1, 13.6, 24.1 and 25.2; STACK.md sections 3, 10 and 35; ADRs 0012 and 0015; issue #1246

## Context

ADR 0015 left out Monaco's language services and answered "no IntelliSense" with
the coding agent beside the editor. A traditional programming course has no
such answer. Students there need completion, hover, go to definition, rename,
format and error marks.

## Decision

1. **Real language servers run inside each workspace**: pyright and
   typescript-language-server (with TypeScript 6), and `ruff server` for
   Python format only. They ship in the Debian package's agent tree, so no
   image rebuild is needed.
2. **A thin LSP client of our own** in `apps/web/src/lsp/` feeds Monaco. Protocol
   types are a type-only dev dependency.
3. **One path**: browser, API relay, agent route, server stdio. The relay is
   owner only and never reads frames. The agent rewrites the paths and process id
   in `initialize`. No message body is logged.
4. **Bounded cost**: one server per project and id, stopped 60 seconds after the
   last socket closes, at most 3 `python` or `typescript` servers per workspace,
   a 1,024 MiB heap cap, and one window at a time.
5. **An administrator switch** (`settings.code_help_enabled`, on by default)
   turns code help off for the site.

## Consequences

- Students get real code help with no network access and no install step.
- The package grows by about 45 MB unpacked, and memory per active student rises.
  The 8 GiB pilot server cannot hold a full class; the bar is 25 students on a
  16 GiB server (SPEC.md section 25.2).
- Servers run as the student, so this is scope and not isolation (SPEC.md section 24.4).
- A new language is one table entry, one contract value, one web line, image
  packages and tests.
- We own about 800 lines of client code, in return for no extra editor packages.
- Rejected: Monaco's in-browser TypeScript service, monaco-languageclient,
  Monaco's built-in LSP client and openvscode-server (STACK.md section 35).
