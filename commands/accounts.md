---
description: Show Claude accounts and usage, or add / import / remove / pause / resume / relogin one
argument-hint: "[import|add|relogin|remove|pause|resume] [name]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cam.mjs" accounts $ARGUMENTS 2>&1`

Show the output above to the user exactly as printed, in a code block. Do not run anything else and do not add analysis unless it shows an error.
