# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-12

First public release.

### Added
- Claude as the master agent: start, message, stop and retry Codex, Kimi, Hermes, OpenCode and Claude helper agents in any arrangement (`/duo`, `agent_*` MCP tools).
- Dashboard for VS Code and Antigravity with Home, Accounts, Agents, Agent Map, Platforms & Models, Logs and Help tabs, plus a status bar summary.
- Usage tracking for Claude (5-hour and weekly), Codex and Antigravity accounts, with reset times and a weekly plan.
- Automatic Claude Code account switching, with manual switch, hold and pause.
- Limit and restart recovery: queued turns, automatic resume, context recap, stall watchdog.
- Per-agent models with a model list when a requested model doesn't exist.
- One-command install and uninstall for Windows (`cam install`).
- Optional session priming, off by default (`cam ready on`).

[Unreleased]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/releases/tag/v1.0.0
