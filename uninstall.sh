#!/bin/bash
# Removes apple-mail-mcp from Claude Desktop's config.
set -euo pipefail

CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
[ -f "$CFG" ] || { echo "No Claude config found."; exit 0; }

BAK="$CFG.bak.$(date +%Y%m%d%H%M%S)"
cp "$CFG" "$BAK"
if plutil -remove mcpServers.apple-mail "$CFG" 2>/dev/null; then
  echo "Removed apple-mail from Claude config. Backup: $BAK"
  echo "Quit Claude (Cmd+Q) and open it again."
else
  echo "apple-mail was not configured."
fi
