#!/bin/bash
# Registers apple-mail-mcp in Claude Desktop's config. Safe to re-run.
# For any other MCP client: ./install.sh --print shows the config block to paste.
# Options (the same settings as the .mcpb extension). Settings from an earlier install are kept
# unless an option changes them:
#   --read-only / --no-read-only   hide / show the write tool
#   --account NAME                 default Mail account ("" clears it)
#   --save-dir DIR                 attachments folder, default ~/Downloads ("" clears it)
#   --reset                        forget all earlier settings
#   --print                        only print the config block for another MCP client
set -euo pipefail

READ_ONLY="-"; ACCOUNT="-"; SAVE_DIR="-"; RESET=""; PRINT=""   # "-" = keep what is there
while [ $# -gt 0 ]; do
  case "$1" in
    --read-only) READ_ONLY="true"; shift ;;
    --no-read-only) READ_ONLY=""; shift ;;
    --account) [ $# -ge 2 ] || { echo "--account needs a name"; exit 1; }; ACCOUNT="$2"; shift 2 ;;
    --save-dir) [ $# -ge 2 ] || { echo "--save-dir needs a folder"; exit 1; }; SAVE_DIR="$2"; shift 2 ;;
    --reset) RESET="1"; shift ;;
    --print) PRINT="1"; shift ;;
    -h|--help) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$DIR/server/apple-mail-mcp.js"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
[ -f "$SERVER" ] || { echo "server/apple-mail-mcp.js not found"; exit 1; }

if [ -n "$PRINT" ]; then # config block for any MCP client; nothing is written
  SERVER="$SERVER" READ_ONLY="$READ_ONLY" ACCOUNT="$ACCOUNT" SAVE_DIR="$SAVE_DIR" /usr/bin/osascript -l JavaScript - <<'JS'
ObjC.import('Foundation');
function env(k) { var v = $.NSProcessInfo.processInfo.environment.objectForKey(k); return v.isNil() ? '' : ObjC.unwrap(v); }
var e = {};
if (env('READ_ONLY') && env('READ_ONLY') !== '-') e.APPLE_MAIL_READ_ONLY = 'true';
if (env('ACCOUNT') && env('ACCOUNT') !== '-') e.APPLE_MAIL_DEFAULT_ACCOUNT = env('ACCOUNT');
if (env('SAVE_DIR') && env('SAVE_DIR') !== '-') e.APPLE_MAIL_SAVE_DIR = env('SAVE_DIR');
var server = { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', env('SERVER')] };
if (Object.keys(e).length) server.env = e;
JSON.stringify({ mcpServers: { 'apple-mail': server } }, null, 2);
JS
  exit 0
fi
mkdir -p "$(dirname "$CFG")"

BAK=""
if [ -s "$CFG" ]; then BAK="$CFG.bak.$(date +%Y%m%d%H%M%S)"; cp "$CFG" "$BAK"; fi

# The config is edited as JSON by JavaScript for Automation (built into macOS); values come in through env.
SETTINGS=$(CFG="$CFG" SERVER="$SERVER" READ_ONLY="$READ_ONLY" ACCOUNT="$ACCOUNT" SAVE_DIR="$SAVE_DIR" RESET="$RESET" /usr/bin/osascript -l JavaScript - <<'JS'
ObjC.import('Foundation');
function env(k) { var v = $.NSProcessInfo.processInfo.environment.objectForKey(k); return v.isNil() ? '' : ObjC.unwrap(v); }
var path = env('CFG'), text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null), cfg = {};
if (!text.isNil() && ObjC.unwrap(text).trim()) {
  try { cfg = JSON.parse(ObjC.unwrap(text)); } catch (e) { throw new Error('Claude config is not valid JSON: ' + path + ' — fix it or restore a .bak copy, then run again.'); }
}
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
if (!isObject(cfg) || (cfg.mcpServers !== undefined && !isObject(cfg.mcpServers))) throw new Error('Claude config has an unexpected shape (mcpServers is not an object): ' + path);
cfg.mcpServers = cfg.mcpServers || {};
var old = cfg.mcpServers['apple-mail'], settings = {};
if (!env('RESET') && old && isObject(old.env)) for (var k in old.env) settings[k] = old.env[k];
function setting(name, value) { if (value === '-') return; if (value) settings[name] = value; else delete settings[name]; }
setting('APPLE_MAIL_READ_ONLY', env('READ_ONLY'));
setting('APPLE_MAIL_DEFAULT_ACCOUNT', env('ACCOUNT'));
setting('APPLE_MAIL_SAVE_DIR', env('SAVE_DIR'));
cfg.mcpServers['apple-mail'] = { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', env('SERVER')], env: settings };
if (!$(JSON.stringify(cfg, null, 2) + '\n').writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) throw new Error('Could not write ' + path);
Object.keys(settings).length ? 'Settings:  ' + JSON.stringify(settings) : '';
JS
)

echo "Installed: $SERVER"
if [ -n "$SETTINGS" ]; then echo "$SETTINGS"; fi
if [ -n "$BAK" ]; then echo "Backup:    $BAK"; fi
echo "Now quit Claude (Cmd+Q) and open it again."
