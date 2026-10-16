<p align="center">
  <img src="icon.png" width="96" alt="">
</p>

<h1 align="center">Apple Mail, Calendar & Notes MCP</h1>

<p align="center">
  Let your AI assistant read, search, triage and send your mail, manage your calendar and keep notes —<br>
  using the Mail, Calendar and Notes apps already on your Mac. Works with any MCP client.
</p>

<p align="center">
  <a href="../../releases/latest"><b>Download the latest release</b></a> ·
  <a href="#install">Install</a> ·
  <a href="#what-it-can-do">What it can do</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## Why this exists

Most AI mail connectors live in the cloud and only work with Gmail or Outlook. If your mail lives in **Apple Mail** — a self-hosted IMAP server, iCloud, a company account — there was no clean way to give an assistant access.

This [MCP](https://modelcontextprotocol.io) server talks to the apps on your Mac directly. That means:

- **Any MCP client.** Desktop chat apps, local-model apps, coding agents — anything that can start an MCP server over stdio.
- **Any account Apple Mail can open works.** Self-hosted, iCloud, Exchange, Gmail-via-IMAP — if it's in Mail.app, your assistant can see it.
- **Nothing to install.** No Node, no Python, no Homebrew. It runs on JavaScript for Automation, which ships with every Mac.
- **Your mail stays on your Mac.** The server has no network code. The assistant only sees what it asks for; where that goes next depends on your model (a local model keeps everything on the Mac).
- **Two permission prompts, not thirty.** Everything is grouped into a `read` tool and a `write` tool. Approve `read` once and forget about it.
- **Works with small local models too.** Arguments are forgiving (`"true"`, `"3 days ago"`, `folder` instead of `mailbox`), and every mistake comes back with a plain "how to fix" line instead of a dead end.

## What it can do

Ask in plain words — *"what's waiting for my reply?"*, *"forward the printer invoice to accounting"*, *"put a call with Sam on Tuesday at 1pm"*, *"save the PDFs from the contract email"*. Under the hood:

### 📥 Triage — *"what needs my attention?"*

| | |
| --- | --- |
| **Needs response** | Emails from real people you haven't answered yet. Ignores no-reply senders and notifications. |
| **Awaiting reply** | Emails *you* sent that none of the recipients has answered. Great for follow-ups. |
| **Conversation view** | A whole thread in order — their messages and your replies — from every folder, including Sent. Messages count as one conversation only when the subject *and* the people match. |
| **Replied / forwarded / flagged** | Every message in a list shows whether you already replied, so the assistant doesn't nag you twice. |

### 🔎 Read & search

| | |
| --- | --- |
| **Inbox and folders** | Latest messages in any folder, unread counts, all accounts. |
| **Search** | By subject, sender or message text; by date range; unread, flagged or with attachments; in one folder or everywhere. |
| **Read a message** | Headers, recipients, plain-text body (long ones in pages) and a list of attachments. |
| **Attachments** | See names, sizes and types — and save them into your attachments folder. |

### ✉️ Write

| | |
| --- | --- |
| **Send** | New emails with To / Cc / Bcc, from any of your addresses. |
| **Reply / reply all** | With the original quoted below. Opens as a draft you check and send. |
| **Forward** | With attachments and an optional note on top. Opens as a draft too. |
| **Draft mode** | Replies and forwards open in Mail by default, because Mail itself picks their recipients and quote. New emails can open as drafts as well. |

### 🗂 Organize

| | |
| --- | --- |
| **Folders** | Create folders, including nested ones (`Alerts/Kubernetes`). |
| **Move & delete** | Move messages between folders or to the account's Trash — with a **dry run** that shows what would change first. |
| **Flags & read status** | Flag in any colour, mark read or unread — one message or a batch. |
| **Rules** | Create, list, enable, disable and delete Mail rules, so new mail sorts itself. |

### 📅 Calendar

| | |
| --- | --- |
| **Events** | See what's on for any date range across all calendars, repeating events included; create and delete events. A date alone makes an all-day event. |

### 📝 Notes

| | |
| --- | --- |
| **Browse & search** | Folders, recent notes, search by title or text. Recently Deleted stays hidden unless you ask. |
| **Write** | Create notes, append to them or rewrite them; delete to Recently Deleted. |

## Install

You need macOS 14 or later (older versions will likely work but aren't tested) and an MCP client.

### Any MCP client

Get the code — `git clone https://github.com/ipsupport-llc/apple-mail-mcp`, or unzip the `.mcpb` from the [latest release](../../releases/latest) — and add the server to your client's config. It runs on the Mac's own `osascript`:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "/usr/bin/osascript",
      "args": ["-l", "JavaScript", "/path/to/apple-mail-mcp/server/apple-mail-mcp.js"]
    }
  }
}
```

`./install.sh --print` prints this block with the right path. The server is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.ipsupport-llc/apple-mail-mcp`.

The first time the assistant touches Mail, Calendar or Notes, macOS asks whether your client may control them — click **Allow**.

### Claude Desktop (one click)

1. Download **`apple-mail-mcp.mcpb`** from the [latest release](../../releases/latest).
2. Double-click it and click **Install**.

Updates, settings and removal live in **Settings → Extensions**.

### Settings

As environment variables in the server's `env` (Claude Desktop: **Settings → Extensions → Apple Mail, Calendar & Notes → Configure**):

| Variable | What it does |
| --- | --- |
| `APPLE_MAIL_READ_ONLY=true` | Removes the `write` tool entirely. The assistant can read and search, but can't send, move, delete or create anything. A good default for a shared or work machine. |
| `APPLE_MAIL_DEFAULT_ACCOUNT` | Used when the assistant doesn't name an account, e.g. `Work`. |
| `APPLE_MAIL_SAVE_DIR` | Where saved attachments go. Defaults to `~/Downloads`. |

### Tool permissions

Most clients ask before using a tool. We recommend allowing `read` once and approving `write` each time, so you always see what gets sent, moved or deleted.

## Safety

- **Mail and notes are never deleted for good.** Mail goes to the account's Trash, notes go to Recently Deleted. Where that isn't possible — an account without a Trash folder, a Notes account without Recently Deleted (e.g. Exchange), something already in the trash, a locked note — the extension refuses and says why. Mail rules that delete are only allowed when every account keeps deleted mail in its Trash.
- **Calendar events and rules have no trash in macOS.** Deleting one returns a full copy of it, so it can be recreated on request.
- **Replies and forwards are drafts by default.** Mail fills in their recipients and quote, so you see the real thing in Mail and press *Send* yourself.
- **No accidental repeats.** The same send, reply, delete or create call twice within 15 minutes is refused — a stuck model can't send an email five times.
- **Repeating events are deleted only on purpose.** Deleting one removes the whole series, so the extension asks for `whole_series: true`.
- **Dry runs.** Bulk moves and deletes can be previewed before they happen.
- **Attachments stay in one place.** They are saved only inside the attachments folder from the settings and are never overwritten — an existing file gets `(1)`, `(2)`… appended.
- **Watch out for instructions hidden in emails.** Anything the assistant reads becomes part of its context, and a malicious email could try to tell it to do something. Keep `write` on manual approval, or turn on read-only mode, if that worries you.
- **One readable file.** The whole server is [`server/apple-mail-mcp.js`](server/apple-mail-mcp.js), with no dependencies and no network calls.

## FAQ

**Do Mail rules run when my Mac is asleep?**
No. Apple Mail rules only run while Mail is open, and only on new mail. To sort old mail, ask the assistant to move it. If your mail server supports Sieve, server-side filters are more reliable across devices.

**The assistant can't read a note.**
It's probably locked. Unlock it in Notes first; locked notes stay private.

**Search is slow.**
Apple Mail's scripting is slow on very large folders, and searching message text is the slowest. Narrow it to an account, a folder or a date range.

**The tools don't show up.**
Check that the server is enabled in your client, then restart the client. `./test.sh` talks to the server directly, without any client. (Claude Desktop: **Settings → Extensions**; logs in `~/Library/Logs/Claude/`.)

**"Not authorized to send Apple events".**
Open **System Settings → Privacy & Security → Automation** and allow your MCP client (the app that starts the server) to control Mail, Calendar and Notes.

---

<details>
<summary><b>Tool reference</b> (for the curious)</summary>

Two tools, each taking `{ "action": "...", "args": { ... } }`. The full list of arguments is in each tool's description.

**`read`** — never changes anything

| Action | Purpose |
| --- | --- |
| `needs_response` | Emails from people that wait for your answer |
| `awaiting_reply` | Your sent emails with no answer |
| `get_thread` | Whole conversation, oldest first |
| `list_messages` | Latest messages in a folder, with replied / forwarded / flagged |
| `search_messages` | Text (subject, sender, body), dates, unread, flagged, attachments, all folders |
| `read_message` | One full message |
| `list_attachments` | Attachments of a message |
| `list_accounts` | Mail accounts and addresses |
| `list_mailboxes` | Folders with unread counts |
| `list_rules` | Mail rules with conditions and actions |
| `list_calendars` | Calendars |
| `list_events` | Events in a date range, repeating events expanded |
| `list_note_folders` | Notes accounts and folders |
| `list_notes` | Recent notes |
| `search_notes` | Search notes |
| `read_note` | One full note |

**`write`** — changes things (hidden in read-only mode)

| Action | Purpose |
| --- | --- |
| `send_email` | New email (`draft: true` opens it instead) |
| `reply_message` | Reply / reply all — opens as a draft in Mail by default, `draft: false` sends |
| `forward_message` | Forward with attachments — draft by default, `draft: false` sends |
| `set_read` | Mark read / unread, one or many |
| `set_flag` | Flag / unflag with colour |
| `move_messages` | Move to another folder (`dry_run` available) |
| `delete_messages` | Move to the account's Trash (`dry_run` available) |
| `save_attachments` | Save attachments into the attachments folder |
| `create_mailbox` | New folder |
| `create_rule` · `set_rule_enabled` · `delete_rule` | Mail rules (a deleted rule comes back as a copy) |
| `create_event` · `delete_event` | Calendar events (`whole_series: true` to delete a repeating one; a deleted event comes back as a copy) |
| `create_note` · `update_note` · `delete_note` | Notes |

Message ids come from list and search results; pass `account` and `mailbox` from the same row. If the folder is wrong, the message is found by its id anyway.

Small models get help: argument names are matched loosely (`folder` → `mailbox`, `messageId` → `id`), values are converted (`"false"`, `"1,2,3"`, `"tomorrow"`), short action names work (`reply`, `search`), and every result explains in `notes` how the call was read. Anything that sends, deletes or creates is never guessed: there, unclear input is an error with a hint.
</details>

<details>
<summary><b>Manual install & development</b></summary>

Run the server straight from a checkout instead of the `.mcpb`:

```sh
git clone https://github.com/ipsupport-llc/apple-mail-mcp.git ~/code/apple-mail-mcp
cd ~/code/apple-mail-mcp
./install.sh --print   # any client: prints the config block to paste
./install.sh     # Claude Desktop: adds an "apple-mail" entry to claude_desktop_config.json (backs it up first)
./test.sh        # talks to the server directly and prints your accounts and calendars
./uninstall.sh   # removes the entry
```

`install.sh` takes the same settings as the extension: `--read-only` / `--no-read-only`, `--account Work`, `--save-dir ~/Documents/Attachments`. Running it again keeps earlier settings unless you change them (`--reset` forgets them).

Restart Claude Desktop after `install.sh`. Don't use the manual install and the `.mcpb` at the same time.

**Tests** never touch your mail: unit tests run the server against fake Mail, Calendar and Notes apps, protocol tests only speak JSON-RPC. CI runs both on macOS for every pull request.

```sh
/usr/bin/osascript -l JavaScript tests/unit.js server/apple-mail-mcp.js
python3 tests/protocol.py
```

**Releasing:** push a tag and GitHub Actions runs the tests, builds the `.mcpb`, attaches it to a release and lists it in the MCP Registry.

```sh
git tag v1.4.0 && git push origin v1.4.0
```
</details>

## License

MIT © IPSupport LLC. Some feature ideas were inspired by [patrickfreyer/apple-mail-mcp](https://github.com/patrickfreyer/apple-mail-mcp) (MIT).
