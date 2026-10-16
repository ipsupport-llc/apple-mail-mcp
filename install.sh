#!/bin/bash
# Registers apple-mail-mcp in Claude Desktop's config. Safe to re-run.
# Options (the same settings as the .mcpb extension):
#   --read-only          hide the write tool
#   --account NAME       default Mail account
#   --save-dir DIR       attachments folder (default ~/Downloads)
set -euo pipefail

READ_ONLY=""; ACCOUNT=""; SAVE_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --read-only) READ_ONLY="true"; shift ;;
    --account) ACCOUNT="${2:?--account needs a name}"; shift 2 ;;
    --save-dir) SAVE_DIR="${2:?--save-dir needs a folder}"; shift 2 ;;
    -h|--help) sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$DIR/server/apple-mail-mcp.js"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
[ -f "$SERVER" ] || { echo "server/apple-mail-mcp.js not found"; exit 1; }
mkdir -p "$(dirname "$CFG")"

BAK=""
if [ -s "$CFG" ]; then BAK="$CFG.bak.$(date +%Y%m%d%H%M%S)"; cp "$CFG" "$BAK"; fi

# The config is edited as JSON by JavaScript for Automation (built into macOS); values come in through env.
SETTINGS=$(CFG="$CFG" SERVER="$SERVER" READ_ONLY="$READ_ONLY" ACCOUNT="$ACCOUNT" SAVE_DIR="$SAVE_DIR" /usr/bin/osascript -l JavaScript - <<'JS'
ObjC.import('Foundation');
function env(k) { var v = $.NSProcessInfo.processInfo.environment.objectForKey(k); return v.isNil() ? '' : ObjC.unwrap(v); }
var path = env('CFG'), text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null), cfg = {};
if (!text.isNil() && ObjC.unwrap(text).trim()) {
  try { cfg = JSON.parse(ObjC.unwrap(text)); } catch (e) { throw new Error('Claude config is not valid JSON: ' + path + ' — fix it or restore a .bak copy, then run again.'); }
}
var settings = {};
if (env('READ_ONLY')) settings.APPLE_MAIL_READ_ONLY = 'true';
if (env('ACCOUNT')) settings.APPLE_MAIL_DEFAULT_ACCOUNT = env('ACCOUNT');
if (env('SAVE_DIR')) settings.APPLE_MAIL_SAVE_DIR = env('SAVE_DIR');
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers['apple-mail'] = { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', env('SERVER')], env: settings };
$(JSON.stringify(cfg, null, 2) + '\n').writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
Object.keys(settings).length ? 'Settings:  ' + JSON.stringify(settings) : '';
JS
)

echo "Installed: $SERVER"
if [ -n "$SETTINGS" ]; then echo "$SETTINGS"; fi
if [ -n "$BAK" ]; then echo "Backup:    $BAK"; fi
echo "Now quit Claude (Cmd+Q) and open it again."
