# Security policy

Claude Agent Hub handles login tokens for several AI services and runs agent CLIs that can read and change files. We take reports seriously.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's private reporting instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

You'll get a first reply within 7 days. Once a fix is released, we'll credit you in the release notes unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes.

## What is in scope

- Leaks of saved login tokens (`~/.claude-accounts/slots/`, Windows Credential Manager entries) to other users, processes, logs or the network.
- The local API on `127.0.0.1`: bypassing the bearer token, or reaching it from a web page (DNS rebinding, CSRF).
- Agents running with more permissions than the user granted (for example writing files from a read-only agent).
- Command injection through agent names, model names, prompts or file paths.
- The dashboard webview: script injection from agent output.

## Out of scope

- Problems in Claude Code, Codex, Kimi, Hermes, OpenCode or Antigravity themselves. Report those to their maintainers.
- Anything that needs an attacker who already controls your Windows user account.

## How the project protects your data

- Nothing is sent to any server of this project; there is no telemetry.
- Saved Claude logins are stored with the same protection as Claude Code's own login file (your user profile). Antigravity logins stay in Windows Credential Manager.
- The local service listens on `127.0.0.1` only and requires a random bearer token stored in `~/.claude-accounts/hub.json`.
- The dashboard runs under a strict Content Security Policy with a per-load nonce.
