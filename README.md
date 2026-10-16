# apple-mail-mcp

An MCP server that gives Claude Desktop access to **Apple Mail**, **Apple Calendar** and **Apple Notes** on macOS.

- **Zero dependencies.** No Node, Python or Homebrew. It runs on JavaScript for Automation (JXA), which ships with every Mac (`/usr/bin/osascript`).
- **Local only.** Talks to Mail.app, Calendar.app and Notes.app on your machine through Apple Events. Nothing is sent anywhere except what Claude itself sees.
- **Two tools, two permission prompts.** Everything is grouped into `read` (never changes anything) and `write` (sends, deletes, creates).
- **One-click install** as a Claude Desktop Extension (`.mcpb`).

## Install

Requirements: macOS and [Claude Desktop](https://claude.ai/download). Apple Mail with at least one account.

1. Download **`apple-mail-mcp.mcpb`** from the [latest release](../../releases/latest).
2. Double-click it (or drag it into the Claude window). Claude shows the extension details — click **Install**.
3. On first use macOS asks whether **Claude may control Mail / Calendar / Notes** — click **Allow**.

That's it: no Terminal, no config files. Updates and removal live in **Claude → Settings → Extensions**.

<details>
<summary>Manual install (without the .mcpb)</summary>

```sh
git clone https://github.com/ipsupport-llc/apple-mail-mcp.git ~/code/apple-mail-mcp
cd ~/code/apple-mail-mcp
./install.sh      # adds an "apple-mail" entry to claude_desktop_config.json (with a backup)
```

Quit Claude with **Cmd+Q** and reopen it. `./uninstall.sh` removes the entry. Don't use both install methods at once.

`./test.sh` talks to the server directly and prints your accounts and calendars — handy to check permissions.
</details>

## Permissions

Claude asks once per tool. Recommended: **Allow for all tasks** on `read`, keep `write` on **Allow for this task** so you see what gets sent or deleted.

## Tools

Each tool takes `{ "action": "...", "args": { ... } }`.

### `read`

| action | what it does |
| --- | --- |
| `list_accounts` | Mail accounts and their addresses |
| `list_mailboxes` | Folders of an account with unread counts |
| `list_messages` | Latest messages in a folder (default: unified Inbox), optional `unread_only`; each has `replied` / `forwarded` / `flagged` |
| `search_messages` | Substring search in subject and sender |
| `read_message` | Full message: headers, recipients, attachment names, plain-text body |
| `list_rules` | Mail rules with their conditions and actions |
| `list_calendars` | Calendars and whether they are writable |
| `list_events` | Events in a date range, with `uid` |
| `list_note_folders` | Notes accounts and folders with note counts |
| `list_notes` | Notes by last modified, optionally in one folder (Recently Deleted hidden unless asked) |
| `search_notes` | Search notes by title and text |
| `read_note` | Full note as plain text (or HTML) |

### `write`

| action | what it does |
| --- | --- |
| `send_email` | New message; `draft: true` opens it in Mail instead of sending |
| `reply_message` | Reply / reply-all; `draft: true` opens it instead of sending |
| `set_read` | Mark read / unread |
| `delete_messages` | Move messages to Trash (recoverable) |
| `create_mailbox` | New folder, nested with `/` (e.g. `Alerts/Kubernetes`) |
| `move_messages` | Move messages to another folder |
| `create_rule` | New rule: conditions on from/to/cc/subject/content, actions move / mark read / flag / delete / stop |
| `set_rule_enabled` | Turn a rule on or off |
| `delete_rule` | Delete a rule |
| `create_event` | New calendar event (ISO 8601 times with offset) |
| `delete_event` | Delete an event by `uid` |
| `create_note` | New note from plain text (or HTML), in any folder |
| `update_note` | Append to a note or replace its body |
| `delete_note` | Delete a note (to Recently Deleted) |

Message ids come from `list_messages` / `search_messages` and are scoped to `account` + `mailbox`.

## Notes on Mail rules

Apple Mail rules run only while Mail is open on the Mac, and only on new mail. To sort existing mail, search and use `move_messages`. If your mail server supports Sieve, server-side filters are more reliable across devices.

## Releasing

Push a tag — GitHub Actions validates the manifest, builds `apple-mail-mcp.mcpb` and attaches it to a release:

```sh
git tag v1.2.1 && git push --tags
```

## Security notes

- Anything Claude reads (email bodies included) becomes part of its context. A malicious email could try to instruct Claude to do something. Keep `write` on manual approval unless you trust the workflow.
- Deleting only moves mail to Trash and notes to Recently Deleted; nothing is permanently erased.
- The server has no network code. Read `server/apple-mail-mcp.js` — it is one file.

## Troubleshooting

- **Tools don't show up in Claude** — check Settings → Extensions that *Apple Mail & Calendar* is enabled, then Cmd+Q and reopen Claude. For a manual install, validate the config: `plutil -lint ~/Library/Application\ Support/Claude/claude_desktop_config.json`.
- **"Not authorized to send Apple events"** — System Settings → Privacy & Security → Automation → enable Mail / Calendar / Notes for Claude (and Terminal for `test.sh`).
- **Locked notes** — password-protected notes can't be read until you unlock them in Notes.
- **Slow searches** — Apple Mail scripting is slow on huge folders. Pass `account` and `mailbox` to narrow the search.
- **Logs** — Claude Desktop writes server stderr to `~/Library/Logs/Claude/` (`mcp-server-*.log`).

## License

MIT
