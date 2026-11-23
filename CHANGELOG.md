# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.10] - 2026-11-23

### Added
- Master switch at the top right of the dashboard (also `cam on` / `cam off`). Off: nothing runs on its own (no usage checks, switching, priming, sign-in renewals or notifications), the chat hooks stay silent, and no agent can start, from the chat or the dashboard. Manual actions (switch, sign in, Test) still work, and Claude Code itself is unaffected. While off, every page shows a banner with a Turn on button, and the status bar shows "Agent Hub off". Agents waiting for a limit continue once it is on again.

## [1.0.9] - 2026-11-23

### Fixed
- Saved Claude logins being revoked by Anthropic ("OAuth access token has been revoked"). Claude Code renews its own login every few hours and Anthropic retires the old refresh token each time; the saved copy of the active account still held that retired token, and if the service could not yet verify the renewed login (for example a network hiccup on the profile check) it renewed the saved copy with the retired token. Anthropic treats a reused refresh token as stolen and revokes the whole login. The service now never renews, primes or tests the saved copy of the account Claude Code is on, and touches no saved copy while Claude Code's login is unverified.
- A sign-in that cannot be renewed is reported as signed out ("Sign in again") after two attempts 30 minutes apart, instead of "could not refresh it yet" forever, and is no longer chosen for switching.
- Plugin hook errors at the start of a chat ("Busy: another account operation is running"): hooks no longer renew sign-ins and give up quietly after 15 seconds instead of running into Claude Code's hook time limit.
- The "% of weekly unused" notification repeated every 30 minutes (the reset time from Anthropic jitters by seconds); it now fires once per weekly window.
- Status and the start-of-chat message said "auto-priming ON" and listed a next "hi" while priming was switched off.

## [1.0.8] - 2026-11-17

### Fixed
- Idle accounts showed "sign-in token expired and Claude Code could not refresh it yet" about 8 hours after their last use whenever session priming was off. `claude auth status`, which the service used to renew sign-ins, no longer renews an expired token in current Claude Code versions; the priming "hi" had been renewing them as a side effect. The service now starts Claude Code with a slash command that does not exist: Claude Code renews the sign-in on start and answers "Unknown skill" locally, with no model call, no tokens and no 5-hour window started. A log entry is written if a renewal ever does reach the model.

## [1.0.7] - 2026-11-16

### Added
- `cam diagnose`: one troubleshooting report (versions, doctor, account state, a connection test of every variant, Windows network and Defender settings, proxy settings, extensions, recent log). Emails are shortened and no tokens are printed; it is also saved to ~/.claude-accounts/diagnose.txt.
- cam doctor tests the connection to Anthropic by type (IPv4, IPv6, normal and small handshake) and says which one fails.

### Fixed
- Computers whose connection to Anthropic is reset part of the time while the same network works elsewhere: after a failed request the service now also tries IPv4 and a small classic handshake, and keeps using whichever works.
- "Save this account" on a login that is already saved under another name no longer creates a duplicate: it updates that account's saved sign-in. Without an identity verified by Anthropic it refuses instead of guessing.

## [1.0.6] - 2026-11-16

### Fixed
- The status bar said only "Agent Hub" when Claude Code was signed in to an account that is not saved here. It now shows that login ("name · not saved"), or "Claude: not signed in". A frozen account shows a lock icon.

## [1.0.5] - 2026-11-16

### Fixed
- A usage check that failed for a temporary reason (network, outage, rate limit) is retried as soon as its back-off ends (5 minutes), instead of at the next regular check (30 minutes for idle accounts).

## [1.0.4] - 2026-11-16

### Fixed
- Usage checks failing with a bare "fetch failed" on some computers while Claude Code itself works. When Node's fetch cannot connect, the request is retried trusting the Windows certificate store (antivirus HTTPS scanning, company networks) and through HTTPS_PROXY / HTTP_PROXY if set. If that also fails, the error names the real cause (certificate, DNS, blocked connection) instead of "fetch failed".
- cam doctor checks the connection to api.anthropic.com and says which path works.

## [1.0.3] - 2026-11-16

### Fixed
- Computers where Claude Code came only with the VS Code / Antigravity extension: the service now finds the CLI bundled with the extension (newest version), and the standalone install in ~/.local/bin, instead of relying on PATH. Without it, sign-in tokens could not be refreshed, Test and priming failed, and the version showed as "unknown". The CLI is looked up again every minute, so installing Claude Code later needs no restart.
- A failed usage check no longer looks like an unused account: each Claude account card shows when usage was last checked, or why the check failed, or that it has not been checked yet.
- Home no longer says "No account managed yet" when accounts are saved but Claude Code is signed in to a different login (it offers to save that login, or to switch) or is not signed in (it offers to switch).
- cam doctor shows where the Claude CLI was found and the last usage check of every account.

## [1.0.2] - 2026-11-16

### Added
- **Freeze** on the active Claude account (Accounts tab, or `cam freeze` / `cam unfreeze`). Claude Code stays on that account, even past its limits, until you unfreeze it: no automatic switch of any kind, and switches to other accounts are refused. Unfreezing hands control back to automatic switching right away.
- The Accounts tab (Claude Code) has the same Automation switches as Home (background monitoring, automatic switching, session priming), always in sync.

### Fixed
- Priming could postpone an account for hours: each re-plan pushed the account whose weekly limit resets last to the end of the queue, and a new account with no weekly window yet never got a "hi". Idle accounts are now served first come, first served, and the k-th in the queue waits at most k + 1 slots (5h / N) after its window ended.
- After a "hi", the usage numbers can take a minute to show the new window; with idle accounts checked every 30 minutes, the same account could get a second "hi" 10 minutes later. The window is now re-checked before any repeat.
- After a long sleep, "hi"s go out at least 15 minutes apart instead of all at once.

### Changed
- The dashboard is called "Agent Hub" again in the editor tab, header and Extensions view.

## [1.0.1] - 2026-11-13

### Added
- Switching at chat boundaries: when a new chat starts and the active account is already past 90% of its 5-hour session (`newChatSwitchAt`), it moves to a clearly better account right away. A new chat has no history to reread on the other account, so this avoids a costlier switch in the middle of the next chat.
- The switch notice now explains what a mid-chat switch means: the chat keeps its full history, but Claude's earlier private reasoning and the prompt cache stay with the old account, so the next reply rereads the chat once. It suggests `/compact` or a new chat in long sessions.

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

[Unreleased]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.10...HEAD
[1.0.10]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Anreddykarthikreddy3003/Claude-agent-hub/releases/tag/v1.0.0
