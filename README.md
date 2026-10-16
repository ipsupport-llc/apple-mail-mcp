<p align="center">
  <img src="icon.png" width="96" alt="">
</p>

<h1 align="center">Apple Mail, Calendar & Notes for Claude</h1>

<p align="center">
  Let Claude Desktop read, search, triage and send your mail, manage your calendar and keep notes —<br>
  using the Mail, Calendar and Notes apps already on your Mac.
</p>

<p align="center">
  <a href="../../releases/latest"><b>Download the latest release</b></a> ·
  <a href="#install">Install</a> ·
  <a href="#what-claude-can-do">What it can do</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## Why this exists

Most Claude connectors live in the cloud and only work with Gmail or Outlook. If your mail lives in **Apple Mail** — a self-hosted IMAP server, iCloud, a company account — there was no clean way to give Claude access.

This extension talks to the apps on your Mac directly. That means:

- **Any account Apple Mail can open works.** Self-hosted, iCloud, Exchange, Gmail-via-IMAP — if it's in Mail.app, Claude can see it.
- **Nothing to install.** No Node, no Python, no Homebrew. It runs on JavaScript for Automation, which ships with every Mac.
- **Your mail stays on your Mac.** The extension has no network code. Claude only sees what it asks for.
- **Two permission prompts, not thirty.** Everything is grouped into a `read` tool and a `write` tool. Approve `read` once and forget about it.

## What Claude can do

Ask in plain words — *"what's waiting for my reply?"*, *"forward the printer invoice to accounting"*, *"put a call with Sam on Tuesday at 1pm"*, *"save the PDFs from the contract email"*. Under the hood:

### 📥 Triage — *"what needs my attention?"*

| | |
| --- | --- |
| **Needs response** | Emails from real people you haven't answered yet. Ignores no-reply senders, alerts and newsletters. |
| **Awaiting reply** | Emails *you* sent that nobody has answered. Great for follow-ups. |
| **Conversation view** | A whole thread in order — their messages and your replies — from every folder, including Sent. |
| **Replied / forwarded / flagged** | Every message in a list shows whether you already replied, so Claude doesn't nag you twice. |

### 🔎 Read & search

| | |
| --- | --- |
| **Inbox and folders** | Latest messages in any folder, unread counts, all accounts. |
| **Search** | By subject, sender or message text; by date range; unread, flagged or with attachments; in one folder or everywhere. |
| **Read a message** | Headers, recipients, plain-text body and a list of attachments. |
| **Attachments** | See names, sizes and types — and save them to disk. |

### ✉️ Write

| | |
| --- | --- |
| **Send** | New emails with To / Cc / Bcc, from any of your addresses. |
| **Reply / reply all** | With the original quoted below. |
| **Forward** | With attachments and an optional note on top. |
| **Draft mode** | Any of the above can open in Mail for you to check and press *Send* yourself. |

### 🗂 Organize

| | |
| --- | --- |
| **Folders** | Create folders, including nested ones (`Alerts/Kubernetes`). |
| **Move & delete** | Move messages between folders or to Trash — with a **dry run** that shows what would change first. |
| **Flags & read status** | Flag in any colour, mark read or unread — one message or a batch. |
| **Rules** | Create, list, enable, disable and delete Mail rules, so new mail sorts itself. |

### 📅 Calendar

| | |
| --- | --- |
| **Events** | See what's on for any date range across all calendars; create and delete events. |

### 📝 Notes

| | |
| --- | --- |
| **Browse & search** | Folders, recent notes, search by title or text. Recently Deleted stays hidden unless you ask. |
| **Write** | Create notes, append to them or rewrite them; delete to Recently Deleted. |

## Install

You need macOS and [Claude Desktop](https://claude.ai/download).

1. Download **`apple-mail-mcp.mcpb`** from the [latest release](../../releases/latest).
2. Double-click it. Claude shows the extension — click **Install**.
3. The first time Claude touches Mail, Calendar or Notes, macOS asks for permission — click **Allow**.

That's it. Updates and removal live in **Claude → Settings → Extensions**.

### Settings

Open **Settings → Extensions → Apple Mail, Calendar & Notes → Configure**:

| Setting | What it does |
| --- | --- |
| **Read-only mode** | Removes the `write` tool entirely. Claude can read and search, but can't send, move, delete or create anything. A good default for a shared or work machine. |
| **Default Mail account** | Used when Claude doesn't name an account, e.g. `Work`. |
| **Attachments folder** | Where saved attachments go. Defaults to `~/Downloads`. |

### Permissions in Claude

Claude asks before using each tool. We recommend **Allow for all tasks** on `read`, and **Allow for this task** on `write`, so you always see what gets sent, moved or deleted.

## Safety

- **Deleting is never permanent.** Mail goes to Trash, notes go to Recently Deleted, both recoverable.
- **Dry runs.** Bulk moves and deletes can be previewed before they happen.
- **Attachments are never overwritten.** A file that already exists gets `(1)`, `(2)`… appended.
- **Watch out for instructions hidden in emails.** Anything Claude reads becomes part of its context, and a malicious email could try to tell it to do something. Keep `write` on manual approval, or turn on read-only mode, if that worries you.
- **One readable file.** The whole server is [`server/apple-mail-mcp.js`](server/apple-mail-mcp.js), with no dependencies and no network calls.

## FAQ

**Do Mail rules run when my Mac is asleep?**
No. Apple Mail rules only run while Mail is open, and only on new mail. To sort old mail, ask Claude to move it. If your mail server supports Sieve, server-side filters are more reliable across devices.

**Claude can't read a note.**
It's probably locked. Unlock it in Notes first; locked notes stay private.

**Search is slow.**
Apple Mail's scripting is slow on very large folders, and searching message text is the slowest. Narrow it to an account, a folder or a date range.

**The tools don't show up.**
Check **Settings → Extensions** that the extension is enabled, then toggle it off and on. Logs are in `~/Library/Logs/Claude/` (`mcp-server-*.log`).

**"Not authorized to send Apple events".**
Open **System Settings → Privacy & Security → Automation** and allow Claude to control Mail, Calendar and Notes.

---

<details>
<summary><b>Tool reference</b> (for the curious)</summary>

Two tools, each taking `{ "action": "...", "args": { ... } }`.

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
| `list_events` | Events in a date range |
| `list_note_folders` | Notes accounts and folders |
| `list_notes` | Recent notes |
| `search_notes` | Search notes |
| `read_note` | One full note |

**`write`** — changes things (hidden in read-only mode)

| Action | Purpose |
| --- | --- |
| `send_email` | New email (or draft) |
| `reply_message` | Reply / reply all (or draft) |
| `forward_message` | Forward with attachments (or draft) |
| `set_read` | Mark read / unread, one or many |
| `set_flag` | Flag / unflag with colour |
| `move_messages` | Move to another folder (`dry_run` available) |
| `delete_messages` | Move to Trash (`dry_run` available) |
| `save_attachments` | Save attachments to disk |
| `create_mailbox` | New folder |
| `create_rule` · `set_rule_enabled` · `delete_rule` | Mail rules |
| `create_event` · `delete_event` | Calendar events |
| `create_note` · `update_note` · `delete_note` | Notes |

Message ids come from list and search results and are scoped to `account` + `mailbox`.
</details>

<details>
<summary><b>Manual install & development</b></summary>

Run the server straight from a checkout instead of the `.mcpb`:

```sh
git clone https://github.com/ipsupport-llc/apple-mail-mcp.git ~/code/apple-mail-mcp
cd ~/code/apple-mail-mcp
./install.sh     # adds an "apple-mail" entry to claude_desktop_config.json (backs it up first)
./test.sh        # talks to the server directly and prints your accounts and calendars
./uninstall.sh   # removes the entry
```

Restart Claude after `install.sh`. Don't use the manual install and the `.mcpb` at the same time.

**Releasing:** push a tag and GitHub Actions validates the manifest, builds the `.mcpb` and attaches it to a release.

```sh
git tag v1.3.1 && git push --tags
```
</details>

## License

MIT © IPSupport LLC. Some feature ideas were inspired by [patrickfreyer/apple-mail-mcp](https://github.com/patrickfreyer/apple-mail-mcp) (MIT).
