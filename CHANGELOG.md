# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- A Cloudflare challenge or outage page from Anthropic no longer marks an account as signed out, so an outage can't trigger needless account switches. Usage checks back off for 15 minutes instead.
- The active account's saved login now stays current. Claude Code rotates the refresh token on every refresh; previously the saved copy could go stale and need a new sign-in.
- A manual switch to an account already past 95% of its session (or 98% weekly) is now held until 100%, instead of being switched straight back.
- No automatic switch within 2 minutes of the previous one, unless the account is used up or signed out.

### Changed
- Far fewer requests to Anthropic. The active account is checked every 3 minutes (every minute once past 85%), idle accounts every 30 minutes and at their reset times. No account is checked more than once per 30 seconds, and `Retry-After` on 429 responses is honored. Previously, heavy use could cause a check after every prompt and reply.

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
