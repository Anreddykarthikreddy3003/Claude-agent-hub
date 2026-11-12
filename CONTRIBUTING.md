# Contributing to Claude Agent Hub

Thanks for helping. Bug reports, new platform adapters and macOS/Linux support are the most useful contributions right now.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through private reporting, not issues. See [SECURITY.md](SECURITY.md).
- Be kind. See the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need Windows 10 or 11, Node.js 20+ and Claude Code. There are no npm dependencies, so there's nothing to install.

```powershell
git clone https://github.com/Anreddykarthikreddy3003/Claude-agent-hub.git
cd Claude-agent-hub
npm test                       # unit tests (node:test)
npm run build:extension        # builds dist/claude-agent-hub.vsix and checks the dashboard script compiles
node bin/cam.mjs daemon --once # one background cycle in the foreground
```

To try your changes end to end, run `node bin/cam.mjs install` from your clone and reload the IDE window.

## Project layout

| Path | What's there |
|---|---|
| `bin/cam.mjs` | CLI entry point |
| `src/engine.mjs` | Account ranking and switching decisions (pure, unit tested) |
| `src/switcher.mjs`, `src/collector.mjs`, `src/accounts.mjs` | Claude account switching, usage polling, sign-in |
| `src/platforms.mjs`, `src/acctest.mjs` | Accounts and usage for Codex, Kimi, Hermes, OpenCode, Antigravity |
| `src/hub/` | Agent registry, turn runner, platform adapters, local HTTP/SSE API |
| `src/mcp.mjs` | MCP tools exposed to Claude |
| `statusbar-extension/` | VS Code / Antigravity extension: dashboard webview and status bar |
| `commands/`, `skills/`, `hooks/` | Claude Code plugin parts |
| `docs/ARCHITECTURE.md` | Design and the reasons behind it |

## Adding a platform

1. Add an adapter to `src/hub/adapters.mjs`: how to start a headless turn, resume a session and turn the CLI's output into events (`user`, `assistant`, `tool`, `file`, `status`, `error`, `usage`).
2. Teach `classify()` the platform's limit, sign-in and model errors.
3. Add its sign-in and usage details to `PLATFORM_DEFS` in `src/platforms.mjs`.
4. Test it for real: start an agent, send two turns (the second must resume), stop it mid-turn.

## Working on the dashboard

The webview script lives inside a template literal in `statusbar-extension/extension.js`. Inside it:
- escape backslashes (`\\s`, `\\n`) and don't use backticks or `${`;
- run `npm run build:extension`, which refuses to package a script that doesn't compile.

Design rules: one neutral system that follows the editor theme, color only where it carries meaning (green ok, orange warning, red error, blue action), sentence case, plain verbs on buttons, visible keyboard focus.

## Pull requests

- Keep each PR to one change and explain why it's needed.
- Run `npm test` and `npm run build:extension` before pushing; CI runs both.
- Add or update tests for decision logic (`src/engine.mjs`, switching, locking).
- Never commit tokens, real account emails or screenshots with personal data. Use `example.com` addresses.
- Update `CHANGELOG.md` under **Unreleased**.
