---
description: Switch Claude Code to another account now (no name = best available)
argument-hint: "[name]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cam.mjs" switch $ARGUMENTS 2>&1`

Show the output above to the user exactly as printed. Do not run anything else.
