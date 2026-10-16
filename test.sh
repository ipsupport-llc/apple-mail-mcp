#!/bin/bash
# Talks to the server directly (no Claude) and prints accounts and calendars.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read","arguments":{"action":"list_accounts"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read","arguments":{"action":"list_calendars"}}}' \
| /usr/bin/osascript -l JavaScript "$DIR/server/apple-mail-mcp.js"
