#!/bin/bash
# Registers apple-mail-mcp in Claude Desktop's config. Safe to re-run.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$DIR/server/apple-mail-mcp.js"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

[ -f "$SERVER" ] || { echo "server/apple-mail-mcp.js not found"; exit 1; }
mkdir -p "$(dirname "$CFG")"
[ -s "$CFG" ] || echo '{}' > "$CFG"

if ! plutil -lint "$CFG" >/dev/null 2>&1; then
  echo "Claude config is not valid JSON: $CFG"
  echo "Fix it (or restore a .bak copy) and run again."
  exit 1
fi

BAK="$CFG.bak.$(date +%Y%m%d%H%M%S)"
cp "$CFG" "$BAK"

# JSON-escape the path (backslashes and quotes)
ESC=$(printf '%s' "$SERVER" | sed 's/\\/\\\\/g; s/"/\\"/g')

plutil -insert mcpServers -json '{}' "$CFG" 2>/dev/null || true
plutil -remove mcpServers.apple-mail "$CFG" 2>/dev/null || true
plutil -insert mcpServers.apple-mail -json \
  "{\"command\":\"/usr/bin/osascript\",\"args\":[\"-l\",\"JavaScript\",\"$ESC\"]}" "$CFG"

echo "Installed: $SERVER"
echo "Backup:    $BAK"
echo "Now quit Claude (Cmd+Q) and open it again."
