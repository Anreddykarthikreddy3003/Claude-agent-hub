# Architecture

Claude Agent Hub runs and monitors several coding agents (Claude, Codex, Hermes, Kimi, OpenCode, Antigravity) from inside VS Code or Antigravity. Your Claude Code chat is the master; the other agents appear as conversations in the dashboard. The design goals are: never lose work to a limit or a restart, never flood the master's context, and never block the editor.

## Processes

```text
VS Code / Antigravity
 ├─ Claude Code extension (unchanged): the master chat
 │    └─ plugin: hooks (usage + switching) and MCP tools (agent_* for orchestration)
 └─ Claude Agent Hub extension: status bar + dashboard webview
          │  HTTP + SSE on 127.0.0.1:<random port>, bearer token from ~/.claude-accounts/hub.json
          ▼
 cam daemon (one per user; a Windows scheduled task restarts it if it stops)
   ├─ accounts: usage polling, switching, optional priming   (src/daemon.mjs, src/switcher.mjs, src/collector.mjs)
   └─ hub: agent registry, turn runner, limit queue, API     (src/hub/*)
```

A single process owns all state. The CLI, hooks, MCP server and dashboard are clients of it, which keeps them small and lets them start instantly.

## Agent model (`src/hub/store.mjs`)

- `~/.claude-accounts/hub/agents/<id>/agent.json`: id, name, platform, model, role, working folder, permission, parent, the platform's own session id, status, token totals, timestamps and account.
- `…/<id>/events.jsonl`: an append-only timeline of normalized events (`user`, `assistant`, `tool`, `file`, `status`, `error`, `usage`, `system`). The dashboard renders it and the recap builder reads it.
- `~/.claude-accounts/hub/links.jsonl`: who messaged whom, for the Agent Map.

## Turn runner (`src/hub/runner.mjs`, `src/hub/adapters.mjs`)

Every message to an agent is one *turn*: start the platform's CLI headless with session resume, stream its JSON output, normalize it into events and store the session id. Starting a process per turn, instead of keeping one alive, gives three properties:

- a Claude turn always uses the account that is active *now*, so switching works for helpers too;
- nothing is lost if the service or the IDE restarts, because state lives on disk and an interrupted turn is retried;
- one uniform path for very different CLIs.

| Platform | Command per turn | Resume by | Events |
|---|---|---|---|
| claude | `claude -p --output-format stream-json --verbose [--resume id]` | session id | full |
| codex | `codex exec --json [resume id] -` | thread id | full |
| hermes | `hermes chat -q … --format stream-json [--resume id]` | session id | full |
| kimi | `kimi -p … --output-format stream-json [-S id]` | session id | full |
| opencode | `opencode run --format json [-s id] …` | session id | full |
| agy | opens in a terminal | | |

`agy --print` produces no output unless it has a real console, so Antigravity agents open in a terminal window for now. Its accounts and quota are fully supported.

On Windows, `child.kill()` leaves the real CLI running under its Node wrapper, so stopping an agent kills the whole process tree (`taskkill /T`).

## Limits and recovery

- Each adapter classifies failures as `limit`, `auth`, `model`, `transient` or `fatal`.
- **Claude limit:** refresh usage, switch to the best available account, retry the same turn with `--resume`. If every account is limited, the agent waits until the earliest reset and the daemon resumes it.
- **Other platforms:** move to another saved account of that platform if there is one, otherwise wait and retry with backoff (15, 30, then 60 minutes).
- **Session gone** (expired, or not portable to the new account): start a new session with a recap built from `events.jsonl`: the original task, decisions and recent messages, capped at about 6k tokens.
- **Stalls:** no output for 15 minutes ends the turn. This catches CLIs that retry provider errors silently forever.

## Context and token rules

- The master never receives raw streams. `agent_read` returns the last reply (capped at 3.5k characters), counts and the transcript path.
- Agents are told to write long findings to `.duo/` and reply with the path and a short summary.
- Token use per agent and per turn comes from usage events and is shown on the dashboard and the map.

## Models (`src/hub/models.mjs`)

- Defaults: `gpt-6.1-sol` for Codex, each platform's own default for the rest. A model given by the user overrides it.
- Requested models are checked against the platform's list. An unknown model doesn't start the agent; the list of available models comes back instead.
- Lists are loaded asynchronously and cached on disk for 24 hours (served immediately, refreshed in the background, with concurrent requests sharing one fetch). Listing used to block the service for several seconds; now a health check answers in about 8 ms during a cold fetch.

## Claude account switching (`src/switcher.mjs`)

Claude Code keeps its login in `~/.claude/.credentials.json`. Each saved account lives in `~/.claude-accounts/slots/<name>/`. A switch:

1. takes the operations lock and reads every file strictly (a corrupt file stops the switch instead of being overwritten);
2. identifies the live login by its token, never by display metadata;
3. saves the outgoing account's current tokens back to its slot (tokens rotate when Claude Code refreshes them);
4. re-checks that the incoming token is still the one it verified, writes it into Claude Code's file without touching other keys (such as MCP logins), and updates the identity in `~/.claude.json`;
5. keeps a backup of every file it changes.

New chats use the new account immediately. A chat that was already open may keep the old login until a new chat starts.

The ranking (`src/engine.mjs`) prefers, in order: an account that would otherwise waste weekly quota, one whose weekly reset is within 24 hours with at least 30% unused, the soonest 5-hour reset, the soonest weekly reset, then the most session left.

## Other platforms' accounts (`src/platforms.mjs`)

- Codex, Kimi, Hermes and OpenCode keep each account in its own home folder (`CODEX_HOME`, `KIMI_CODE_HOME`, `HERMES_HOME`, `XDG_DATA_HOME`).
- Antigravity keeps its login in Windows Credential Manager (generic credential `gemini:antigravity`). Several accounts are saved copies of that credential, swapped in when needed (`src/wincred.mjs`). Signing in saves the current login first and rolls back if the sign-in isn't completed.
- Codex usage comes from ChatGPT's usage endpoint (a weekly window, plus a 5-hour window on plans that have one). Antigravity quota comes from its model-quota endpoint.

## Session priming (optional, off by default)

When an account's 5-hour window has ended, a one-word message starts the next one. Measured costs and limits:

- Claude: about 240 tokens with a minimal system prompt and no tools (12 times less than a default prompt).
- Codex: only on plans with a 5-hour window, and only when the account is idle.
- Antigravity: tested twice; a short message does not start its quota window, so priming isn't offered.
- Hermes, Kimi and OpenCode publish no session window, so there's nothing to start.

## Locking and files

- One lock (`mkdir`-based, with an owner token and a heartbeat; a stale lock is taken over by atomic rename) serializes everything that touches logins.
- JSON files are written atomically (write to a temp file, then rename, with retries for Windows file locks).
