// Apple Mail, Calendar & Notes MCP server — zero dependencies, runs on macOS built-in JXA.
// Run:  /usr/bin/osascript -l JavaScript server/apple-mail-mcp.js
// Protocol: MCP over stdio (newline-delimited JSON-RPC 2.0). Logs go to stderr.

ObjC.import('Foundation');

var Mail = null;
function mail() {
  if (!Mail) { Mail = Application('Mail'); Mail.includeStandardAdditions = false; }
  return Mail;
}

var Cal = null;
function cal() { if (!Cal) Cal = Application('Calendar'); return Cal; }
var NotesApp = null;
function notes() { if (!NotesApp) NotesApp = Application('Notes'); return NotesApp; }

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Plain text -> Notes HTML (one <div> per line). Pass html:true to send raw HTML instead.
function toNoteHtml(text, isHtml) {
  if (isHtml) return String(text);
  return String(text).split('\n').map(function (l) { return '<div>' + (l ? esc(l) : '<br>') + '</div>'; }).join('');
}
function noteFolder(account, folder) {
  var N = notes(), f;
  if (account) f = N.accounts.byName(account).folders.byName(folder);
  else f = N.folders.byName(folder);
  f.name();
  return f;
}
function getNote(id) { var n = notes().notes.byId(String(id)); n.name(); return n; }
var DELETED_FOLDERS = /^(Recently Deleted|Недавно удал[её]нные)$/i;
function noteSummary(spec, limit, includeDeleted) {
  var ids = spec.id();
  if (!ids.length) return [];
  var names = spec.name(), mod = spec.modificationDate();
  var idx = ids.map(function (_, i) { return i; });
  idx.sort(function (x, y) { return (mod[y] || 0) - (mod[x] || 0); });
  var out = [];
  for (var k = 0; k < idx.length && out.length < limit; k++) {
    var i = idx[k], folder = null;
    try { folder = spec[i].container().name(); } catch (e) {}
    if (!includeDeleted && folder && DELETED_FOLDERS.test(folder)) continue;
    out.push({ id: ids[i], title: names[i], folder: folder, modified: iso(mod[i]) });
  }
  return out;
}

// ---------- IO ----------
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function send(obj) {
  var s = JSON.stringify(obj) + '\n';
  stdout.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
}
function log(s) { console.log('[apple-mail-mcp] ' + s); } // stderr

// ---------- config (from Claude Desktop extension settings → env) ----------
function env(k) {
  try { var v = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey(k)); return (v && String(v).indexOf('${') !== 0) ? String(v) : ''; }
  catch (e) { return ''; }
}
var READ_ONLY = /^(1|true|yes)$/i.test(env('APPLE_MAIL_READ_ONLY'));
var DEFAULT_ACCOUNT = env('APPLE_MAIL_DEFAULT_ACCOUNT');
var SAVE_DIR = env('APPLE_MAIL_SAVE_DIR') || (ObjC.unwrap($.NSHomeDirectory()) + '/Downloads');

// ---------- helpers ----------
function iso(d) { try { return d ? new Date(d).toISOString() : null; } catch (e) { return null; } }
function clip(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + '\n…[обрезано, всего ' + s.length + ' символов]' : s; }

function getAccount(name) {
  var a = mail().accounts.byName(name);
  a.name(); // throws if missing
  return a;
}
function getMailbox(account, mailbox) {
  if (!account && (!mailbox || /^inbox$/i.test(mailbox))) return mail().inbox;
  account = account || DEFAULT_ACCOUNT;
  if (!account) throw new Error('Укажите account для ящика "' + mailbox + '"');
  var mb = getAccount(account).mailboxes.byName(mailbox || 'INBOX');
  mb.name();
  return mb;
}
function getMessage(a) {
  var m = getMailbox(a.account, a.mailbox).messages.byId(Number(a.id));
  m.subject();
  return m;
}

function summarize(spec, limit, unreadOnly) {
  // spec = element-array specifier of messages
  var ids = spec.id();
  if (!ids.length) return [];
  var dates = spec.dateReceived(), subs = spec.subject(), senders = spec.sender(), read = spec.readStatus();
  function bulk(f) { try { return spec[f](); } catch (e) { return []; } }
  var replied = bulk('wasRepliedTo'), forwarded = bulk('wasForwarded'), flagged = bulk('flaggedStatus');
  var idx = [];
  for (var i = 0; i < ids.length; i++) if (!unreadOnly || !read[i]) idx.push(i);
  idx.sort(function (x, y) { return (dates[y] || 0) - (dates[x] || 0); });
  idx = idx.slice(0, limit);
  return idx.map(function (i) {
    var acc = null, mbx = null;
    try { var mb = spec[i].mailbox(); mbx = mb.name(); acc = mb.account().name(); } catch (e) {}
    return { id: ids[i], account: acc, mailbox: mbx, date: iso(dates[i]), from: senders[i], subject: subs[i], read: read[i],
      replied: !!replied[i], forwarded: !!forwarded[i], flagged: !!flagged[i] };
  });
}

function recips(list) { return (list || []).map(function (r) { var n = r.name(), a = r.address(); return n ? n + ' <' + a + '>' : a; }); }
function toList(v) { if (!v) return []; if (Array.isArray(v)) return v; return String(v).split(/[,;]\s*/).filter(Boolean); }
function addRecipients(msg, field, ctor, list) {
  toList(list).forEach(function (addr) {
    var m = /^(.*)<(.+)>\s*$/.exec(addr);
    var props = m ? { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() } : { address: addr.trim() };
    msg[field].push(ctor(props));
  });
}

function addrOf(s) { var m = /<([^>]+)>/.exec(s || ''); return (m ? m[1] : String(s || '')).trim().toLowerCase(); }
function normSubject(s) {
  return String(s || '').replace(/^\s*((re|fw|fwd|aw|wg|sv|ответ|отв|пересл|ha)\s*(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function myAddresses() {
  var out = {};
  mail().accounts().forEach(function (a) { try { a.emailAddresses().forEach(function (e) { out[String(e).toLowerCase()] = true; }); } catch (e) {} });
  return out;
}
var SKIP_BOXES = /^(sent|sent items|sent messages|отправленные|trash|deleted items|deleted messages|корзина|junk|junk mail|junk e-mail|spam|спам|drafts|черновики|outbox|исходящие)$/i;
var SENT_BOXES = /^(sent|sent items|sent messages|отправленные)$/i;
// every mailbox of every (or one) account, flattened
function allMailboxes(account) {
  var out = [];
  function walk(list) { list.forEach(function (mb) { out.push(mb); try { var k = mb.mailboxes(); if (k.length) walk(k); } catch (e) {} }); }
  var accs = account ? [getAccount(account)] : mail().accounts();
  accs.forEach(function (acc) { try { walk(acc.mailboxes()); } catch (e) {} });
  return out;
}
// raw rows (with a lazy ref) from a message specifier; filters applied later
function rowsOf(spec) {
  var ids; try { ids = spec.id(); } catch (e) { return []; }
  if (!ids.length) return [];
  function bulk(f) { try { return spec[f](); } catch (e) { return []; } }
  var dates = bulk('dateReceived'), subs = bulk('subject'), senders = bulk('sender'), read = bulk('readStatus');
  var replied = bulk('wasRepliedTo'), forwarded = bulk('wasForwarded'), flagged = bulk('flaggedStatus');
  return ids.map(function (id, i) {
    return { i: i, spec: spec, id: id, date: dates[i], subject: subs[i], from: senders[i], read: read[i],
      replied: !!replied[i], forwarded: !!forwarded[i], flagged: !!flagged[i] };
  });
}
function rowOut(r) {
  var acc = null, mbx = null;
  try { var mb = r.spec[r.i].mailbox(); mbx = mb.name(); acc = mb.account().name(); } catch (e) {}
  return { id: r.id, account: acc, mailbox: mbx, date: iso(r.date), from: r.from, subject: r.subject, read: r.read,
    replied: r.replied, forwarded: r.forwarded, flagged: r.flagged };
}
function newestFirst(a, b) { return (b.date || 0) - (a.date || 0); }
function attachmentsOf(m) {
  try {
    return m.mailAttachments().map(function (x) {
      var o = { name: x.name() };
      try { o.size = x.fileSize(); } catch (e) {}
      try { o.mime = x.mimeType(); } catch (e) {}
      try { o.downloaded = x.downloaded(); } catch (e) {}
      return o;
    });
  } catch (e) { return []; }
}
function idsSummary(mb, ids) {
  return (ids || []).map(function (id) {
    try { var m = mb.messages.byId(Number(id)); return { id: Number(id), date: iso(m.dateReceived()), from: m.sender(), subject: m.subject() }; }
    catch (e) { return { id: Number(id), error: 'not found' }; }
  });
}
function fileExists(p) { return $.NSFileManager.defaultManager.fileExistsAtPath(p); }
function uniquePath(dir, name) {
  var clean = String(name || 'attachment').replace(/[\/:]/g, '_'), p = dir + '/' + clean, n = 1;
  var dot = clean.lastIndexOf('.'), base = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
  while (fileExists(p)) { p = dir + '/' + base + ' (' + (n++) + ')' + ext; }
  return p;
}

// ---------- tools ----------
var TOOLS = [
  { name: 'list_accounts', description: 'Список почтовых аккаунтов Apple Mail и их адресов.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_mailboxes', description: 'Список папок (ящиков) аккаунта с числом непрочитанных.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] } },
  { name: 'list_messages', description: 'Последние письма в папке. Без account/mailbox — общий «Входящие». Каждое письмо с флагами replied/forwarded/flagged — проверяйте replied, прежде чем считать письмо неотвеченным.',
    inputSchema: { type: 'object', properties: {
      account: { type: 'string' }, mailbox: { type: 'string', description: 'по умолчанию INBOX' },
      limit: { type: 'number', description: 'по умолчанию 20' }, unread_only: { type: 'boolean' } } } },
  { name: 'search_messages', description: 'Search mail. Text in subject+sender by default (in: body|any for message text — slower). Filters: dates, unread, flagged, has_attachments. all_mailboxes searches every folder (except Trash/Junk) instead of just the Inbox.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'optional when other filters are set' },
      in: { type: 'string', enum: ['subject_sender', 'subject', 'sender', 'body', 'any'], description: 'default subject_sender' },
      account: { type: 'string' }, mailbox: { type: 'string' }, all_mailboxes: { type: 'boolean' },
      from_date: { type: 'string', description: 'ISO date' }, to_date: { type: 'string', description: 'ISO date' },
      unread: { type: 'boolean' }, flagged: { type: 'boolean' }, has_attachments: { type: 'boolean' },
      limit: { type: 'number', description: 'default 20' } } } },
  { name: 'awaiting_reply', description: 'Your sent emails that got no answer yet (no later message in the same conversation from someone else). Use this before saying "they never replied".',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'look back, default 14' },
      account: { type: 'string' }, limit: { type: 'number', description: 'default 30' } } } },
  { name: 'needs_response', description: 'Emails from real people waiting for YOUR answer: not replied, and you have not written in that conversation since. Skips no-reply/notification senders.',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'look back, default 14' },
      account: { type: 'string' }, limit: { type: 'number', description: 'default 30' } } } },
  { name: 'get_thread', description: 'Whole conversation for a message, oldest first, from all folders including Sent.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' },
      bodies: { type: 'boolean', description: 'include message text (clipped), default true' } }, required: ['id', 'account', 'mailbox'] } },
  { name: 'list_attachments', description: 'Attachments of a message: name, size, MIME type.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' } },
      required: ['id', 'account', 'mailbox'] } },
  { name: 'read_message', description: 'Полный текст письма. id/account/mailbox берутся из list_messages или search_messages.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' } },
      required: ['id', 'account', 'mailbox'] } },
  { name: 'send_email', description: 'Отправить новое письмо. draft=true — только открыть окно письма в Mail без отправки.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'адреса через запятую' }, cc: { type: 'string' }, bcc: { type: 'string' },
      subject: { type: 'string' }, body: { type: 'string' },
      from: { type: 'string', description: 'адрес отправителя (один из адресов аккаунтов), необязательно' },
      draft: { type: 'boolean' } }, required: ['to', 'subject', 'body'] } },
  { name: 'reply_message', description: 'Ответить на письмо. Mail сам подставляет получателей и цитату, поэтому по умолчанию ответ только открывается в Mail (черновик) — пользователь видит, что уйдёт, и нажимает «Отправить». draft=false — отправить сразу.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' },
      body: { type: 'string' }, reply_all: { type: 'boolean' }, draft: { type: 'boolean', description: 'по умолчанию true' } },
      required: ['id', 'account', 'mailbox', 'body'] } },
  { name: 'list_calendars', description: 'Список календарей в приложении Календарь.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_events', description: 'События в диапазоне дат (ISO 8601). Без calendar — по всем календарям.',
    inputSchema: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }, calendar: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'create_event', description: 'Создать событие в Календаре. start/end — ISO 8601 с часовым поясом, напр. 2026-10-27T13:00:00-06:00.',
    inputSchema: { type: 'object', properties: {
      calendar: { type: 'string', description: 'имя календаря; по умолчанию первый доступный для записи' },
      title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
      location: { type: 'string' }, notes: { type: 'string' } }, required: ['title', 'start', 'end'] } },
  { name: 'list_rules', description: 'Mail rules with conditions and actions.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'create_mailbox', description: 'Create a folder in an account. Nested: "Alerts/Kubernetes".',
    inputSchema: { type: 'object', properties: { account: { type: 'string' }, name: { type: 'string' } }, required: ['account', 'name'] } },
  { name: 'move_messages', description: 'Move messages (ids from one folder) to another folder.',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'number' } }, account: { type: 'string' }, mailbox: { type: 'string' },
      to_mailbox: { type: 'string' }, to_account: { type: 'string', description: 'default: same account' },
      dry_run: { type: 'boolean', description: 'only show what would move' } },
      required: ['ids', 'account', 'mailbox', 'to_mailbox'] } },
  { name: 'create_rule', description: 'Create a Mail rule. conditions: [{field: from|to|cc|subject|any_recipient|content, op: contains|not_contains|begins|ends|equals, value}]. Actions: move_to {account, mailbox}, mark_read, flag, delete, stop. Created disabled first, enabled after conditions are set.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, match: { type: 'string', enum: ['all', 'any'], description: 'default all' },
      conditions: { type: 'array', items: { type: 'object', properties: {
        field: { type: 'string' }, op: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'] } },
      move_to: { type: 'object', properties: { account: { type: 'string' }, mailbox: { type: 'string' } } },
      mark_read: { type: 'boolean' }, flag: { type: 'boolean' }, delete: { type: 'boolean' }, stop: { type: 'boolean' },
      enabled: { type: 'boolean', description: 'default true' } }, required: ['name', 'conditions'] } },
  { name: 'set_rule_enabled', description: 'Enable or disable a rule by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['name', 'enabled'] } },
  { name: 'delete_rule', description: 'Delete a rule by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'list_note_folders', description: 'Apple Notes accounts and folders with note counts.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_notes', description: 'Notes sorted by last modified. Without folder — all notes except Recently Deleted.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string' }, account: { type: 'string', description: 'Notes account, e.g. iCloud' },
      limit: { type: 'number', description: 'default 30' }, include_deleted: { type: 'boolean', description: 'also show Recently Deleted' } } } },
  { name: 'search_notes', description: 'Search notes by title and text (substring). Skips Recently Deleted unless include_deleted.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 20' },
      include_deleted: { type: 'boolean' } }, required: ['query'] } },
  { name: 'read_note', description: 'Full note as plain text (id from list_notes/search_notes). html:true returns the HTML body.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, html: { type: 'boolean' } }, required: ['id'] } },
  { name: 'create_note', description: 'Create a note. body is plain text (lines kept) unless html:true. Default folder: Notes.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, html: { type: 'boolean' },
      folder: { type: 'string' }, account: { type: 'string' } }, required: ['title'] } },
  { name: 'update_note', description: 'Change a note: append:true adds text to the end, otherwise replaces the body (title kept unless a new one is given).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' }, html: { type: 'boolean' },
      append: { type: 'boolean' }, title: { type: 'string' } }, required: ['id', 'body'] } },
  { name: 'delete_note', description: 'Delete a note (goes to Recently Deleted in Notes, recoverable ~30 days).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'delete_event', description: 'Удалить событие календаря по uid (uid из list_events).',
    inputSchema: { type: 'object', properties: { uid: { type: 'string' }, calendar: { type: 'string' } }, required: ['uid'] } },
  { name: 'delete_messages', description: 'Переместить письма в Корзину (не безвозвратно). ids — список id из одной папки.',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'number' } }, account: { type: 'string' }, mailbox: { type: 'string' },
      dry_run: { type: 'boolean', description: 'only show what would be deleted' } },
      required: ['ids', 'account', 'mailbox'] } },
  { name: 'set_read', description: 'Mark one (id) or many (ids) messages read/unread.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, ids: { type: 'array', items: { type: 'number' } }, account: { type: 'string' }, mailbox: { type: 'string' },
      read: { type: 'boolean' } }, required: ['account', 'mailbox', 'read'] } },
  { name: 'set_flag', description: 'Flag/unflag messages, optional color: red, orange, yellow, green, blue, purple, gray.',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'number' } }, account: { type: 'string' }, mailbox: { type: 'string' },
      flagged: { type: 'boolean' }, color: { type: 'string' } }, required: ['ids', 'account', 'mailbox', 'flagged'] } },
  { name: 'forward_message', description: 'Forward a message (with its attachments) with an optional note on top. Mail adds the original text and attachments itself, so by default it only opens in Mail as a draft for the user to check and send. draft=false sends right away.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' },
      to: { type: 'string' }, cc: { type: 'string' }, bcc: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean', description: 'default true' } },
      required: ['id', 'account', 'mailbox', 'to'] } },
  { name: 'save_attachments', description: 'Save a message\'s attachments to disk (default: the folder from extension settings, else ~/Downloads). Never overwrites.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' },
      names: { type: 'array', items: { type: 'string' }, description: 'only these files; default all' },
      dir: { type: 'string' } }, required: ['id', 'account', 'mailbox'] } }
];

var HANDLERS = {
  list_accounts: function () {
    return mail().accounts().map(function (a) {
      return { name: a.name(), emails: a.emailAddresses(), enabled: a.enabled() };
    });
  },
  list_mailboxes: function (a) {
    var out = [];
    function walk(mbs, prefix) {
      mbs.forEach(function (mb) {
        var n = mb.name();
        out.push({ mailbox: prefix ? prefix + '/' + n : n, unread: mb.unreadCount() });
        try { var kids = mb.mailboxes(); if (kids.length) walk(kids, prefix ? prefix + '/' + n : n); } catch (e) {}
      });
    }
    walk(getAccount(a.account).mailboxes(), '');
    return out;
  },
  list_messages: function (a) {
    return summarize(getMailbox(a.account, a.mailbox).messages, a.limit || 20, !!a.unread_only);
  },
  search_messages: function (a) {
    var limit = a.limit || 20, conds = [], q = a.query ? String(a.query) : '';
    if (q) {
      var where = a['in'] || 'subject_sender', t = [];
      if (where === 'subject' || where === 'subject_sender' || where === 'any') t.push({ subject: { _contains: q } });
      if (where === 'sender' || where === 'subject_sender' || where === 'any') t.push({ sender: { _contains: q } });
      if (where === 'body' || where === 'any') t.push({ content: { _contains: q } });
      conds.push(t.length > 1 ? { _or: t } : t[0]);
    }
    if (a.from_date) conds.push({ dateReceived: { _greaterThan: new Date(a.from_date) } });
    if (a.to_date) conds.push({ dateReceived: { _lessThan: new Date(a.to_date) } });
    if (a.unread) conds.push({ readStatus: false });
    if (a.flagged) conds.push({ flaggedStatus: true });
    if (!conds.length && !a.has_attachments) throw new Error('Give a query or at least one filter');
    var boxes;
    if (a.all_mailboxes) boxes = allMailboxes(a.account || DEFAULT_ACCOUNT || null).filter(function (mb) { try { return !SKIP_BOXES.test(mb.name()) || SENT_BOXES.test(mb.name()); } catch (e) { return false; } });
    else boxes = [getMailbox(a.account, a.mailbox)];
    var rows = [];
    boxes.forEach(function (mb) {
      var spec = conds.length ? mb.messages.whose(conds.length > 1 ? { _and: conds } : conds[0]) : mb.messages;
      rows = rows.concat(rowsOf(spec));
    });
    rows.sort(newestFirst);
    var out = [];
    for (var k = 0; k < rows.length && out.length < limit; k++) {
      var r = rows[k];
      if (a.has_attachments) { var n = 0; try { n = r.spec[r.i].mailAttachments().length; } catch (e) {} if (!n) continue; }
      out.push(rowOut(r));
    }
    return out;
  },
  awaiting_reply: function (a) {
    var days = a.days || 14, limit = a.limit || 30, cutoff = new Date(Date.now() - days * 864e5), me = myAddresses();
    var sentBoxes = allMailboxes(a.account).filter(function (mb) { try { return SENT_BOXES.test(mb.name()); } catch (e) { return false; } });
    // latest message I sent per conversation
    var mine = {};
    sentBoxes.forEach(function (mb) {
      var spec = mb.messages.whose({ dateSent: { _greaterThan: cutoff } }), ids; try { ids = spec.id(); } catch (e) { return; }
      if (!ids.length) return;
      var subs = spec.subject(), dates = spec.dateSent(), to = [];
      try { to = spec.toRecipients.address(); } catch (e) {}
      ids.forEach(function (id, i) {
        var k = normSubject(subs[i]); if (!k) return;
        if (!mine[k] || dates[i] > mine[k].date) mine[k] = { id: id, mailbox: mb.name(), account: (function () { try { return mb.account().name(); } catch (e) { return null; } })(),
          subject: subs[i], date: dates[i], to: (to[i] || []).join(', ') };
      });
    });
    // latest message from someone else per conversation (any folder except sent/trash/junk)
    var theirs = {};
    allMailboxes(a.account).forEach(function (mb) {
      var name; try { name = mb.name(); } catch (e) { return; }
      if (SKIP_BOXES.test(name)) return;
      var spec = mb.messages.whose({ dateReceived: { _greaterThan: cutoff } }), ids; try { ids = spec.id(); } catch (e) { return; }
      if (!ids.length) return;
      var subs = spec.subject(), dates = spec.dateReceived(), from = spec.sender();
      ids.forEach(function (id, i) {
        if (me[addrOf(from[i])]) return;
        var k = normSubject(subs[i]); if (!k || !mine[k]) return;
        if (!theirs[k] || dates[i] > theirs[k]) theirs[k] = dates[i];
      });
    });
    var out = [];
    Object.keys(mine).forEach(function (k) {
      var s = mine[k];
      if (theirs[k] && theirs[k] > s.date) return;
      out.push({ to: s.to, subject: s.subject, sent: iso(s.date), days_waiting: Math.floor((Date.now() - s.date) / 864e5),
        id: s.id, account: s.account, mailbox: s.mailbox });
    });
    out.sort(function (x, y) { return y.days_waiting - x.days_waiting; });
    return out.slice(0, limit);
  },
  needs_response: function (a) {
    var days = a.days || 14, limit = a.limit || 30, cutoff = new Date(Date.now() - days * 864e5), me = myAddresses();
    var BOT = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|alerting|mailer|mailer-daemon|postmaster|bounces?|newsletters?|news|marketing|updates?|team|hello|info|support|billing|invoices?|receipts?|statements?|security|accounts?|feedback|reviews|probe|automated|system)([._+-]|@)/i;
    // when I last wrote in each conversation
    var lastMine = {};
    allMailboxes(a.account).forEach(function (mb) {
      var name; try { name = mb.name(); } catch (e) { return; }
      if (!SENT_BOXES.test(name)) return;
      var spec = mb.messages.whose({ dateSent: { _greaterThan: cutoff } }), ids; try { ids = spec.id(); } catch (e) { return; }
      if (!ids.length) return;
      var subs = spec.subject(), dates = spec.dateSent();
      ids.forEach(function (_, i) { var k = normSubject(subs[i]); if (k && (!lastMine[k] || dates[i] > lastMine[k])) lastMine[k] = dates[i]; });
    });
    var spec = a.account ? getMailbox(a.account, 'INBOX').messages : mail().inbox.messages;
    var rows = rowsOf(spec.whose({ dateReceived: { _greaterThan: cutoff } }));
    var latest = {};
    rows.forEach(function (r) {
      var from = addrOf(r.from);
      if (me[from] || BOT.test(from)) return;
      var k = normSubject(r.subject) || ('#' + r.id);
      if (!latest[k] || r.date > latest[k].date) latest[k] = r;
    });
    var out = [];
    Object.keys(latest).forEach(function (k) {
      var r = latest[k];
      if (r.replied) return;
      if (lastMine[k] && lastMine[k] > r.date) return;
      var o = rowOut(r); o.waiting_days = Math.floor((Date.now() - r.date) / 864e5); out.push(o);
    });
    out.sort(function (x, y) { return y.waiting_days - x.waiting_days; });
    return out.slice(0, limit);
  },
  get_thread: function (a) {
    var m = getMessage(a), key = normSubject(m.subject()), withBodies = a.bodies !== false;
    if (!key) return [HANDLERS.read_message(a)];
    var core = key.length > 60 ? key.slice(0, 60) : key, rows = [];
    allMailboxes(a.account).forEach(function (mb) {
      var name; try { name = mb.name(); } catch (e) { return; }
      if (/^(trash|deleted items|deleted messages|корзина|junk|junk mail|spam|спам)$/i.test(name)) return;
      rowsOf(mb.messages.whose({ subject: { _contains: core } })).forEach(function (r) { if (normSubject(r.subject) === key) rows.push(r); });
    });
    var seen = {};
    rows.sort(function (x, y) { return (x.date || 0) - (y.date || 0); });
    return rows.filter(function (r) { var k = r.date + '|' + addrOf(r.from); if (seen[k]) return false; seen[k] = 1; return true; })
      .map(function (r) {
        var o = rowOut(r);
        if (withBodies) { try { o.body = clip(r.spec[r.i].content(), 4000); } catch (e) {} }
        return o;
      });
  },
  list_attachments: function (a) { return attachmentsOf(getMessage(a)); },
  read_message: function (a) {
    if (a.mark_read) throw new Error('read never changes mail — use write.set_read to mark it read.');
    var m = getMessage(a);
    var r = {
      id: m.id(), account: a.account, mailbox: a.mailbox, date: iso(m.dateReceived()),
      from: m.sender(), to: recips(m.toRecipients()), cc: recips(m.ccRecipients()),
      reply_to: m.replyTo(), subject: m.subject(), read: m.readStatus(),
      replied: (function () { try { return m.wasRepliedTo(); } catch (e) { return null; } })(),
      forwarded: (function () { try { return m.wasForwarded(); } catch (e) { return null; } })(),
      flagged: (function () { try { return m.flaggedStatus(); } catch (e) { return null; } })(),
      attachments: attachmentsOf(m),
      body: clip(m.content(), 60000)
    };
    return r;
  },
  send_email: function (a) {
    var M = mail();
    var msg = M.OutgoingMessage({ subject: a.subject, content: a.body, visible: !!a.draft });
    M.outgoingMessages.push(msg);
    addRecipients(msg, 'toRecipients', M.ToRecipient, a.to);
    addRecipients(msg, 'ccRecipients', M.CcRecipient, a.cc);
    addRecipients(msg, 'bccRecipients', M.BccRecipient, a.bcc);
    if (a.from) msg.sender = a.from;
    if (a.draft) { M.activate(); return 'Черновик открыт в Mail — проверьте и нажмите «Отправить».'; }
    msg.send();
    return 'Отправлено: ' + toList(a.to).join(', ');
  },
  reply_message: function (a) {
    var M = mail(), m = getMessage(a);
    var orig = '';
    try { orig = m.content(); } catch (e) {}
    var quoted = '\n\n' + (m.sender() + ' написал(а) ' + (iso(m.dateReceived()) || '') + ':\n') +
      orig.split('\n').map(function (l) { return '> ' + l; }).join('\n');
    var draft = a.draft !== false;
    var r = M.reply(m, { openingWindow: draft, replyToAll: !!a.reply_all });
    r.content = a.body + quoted;
    var who = { to: recips(r.toRecipients()), cc: recips(r.ccRecipients()), subject: r.subject() };
    if (draft) { M.activate(); return { status: 'Ответ открыт в Mail — проверьте и нажмите «Отправить».', draft: true, to: who.to, cc: who.cc, subject: who.subject }; }
    r.send();
    return { status: 'Ответ отправлен', to: who.to, cc: who.cc, subject: who.subject };
  },
  set_read: function (a) {
    var mb = getMailbox(a.account, a.mailbox), ids = a.ids || (a.id != null ? [a.id] : []), ok = 0, failed = [];
    if (!ids.length) throw new Error('Give id or ids');
    ids.forEach(function (id) { try { mb.messages.byId(Number(id)).readStatus = !!a.read; ok++; } catch (e) { failed.push(id); } });
    return { updated: ok, failed: failed };
  },
  set_flag: function (a) {
    var COLORS = { red: 0, orange: 1, yellow: 2, green: 3, blue: 4, purple: 5, gray: 6, grey: 6 };
    if (a.color && !(String(a.color).toLowerCase() in COLORS)) throw new Error('Unknown color. Use: ' + Object.keys(COLORS).join(', '));
    var mb = getMailbox(a.account, a.mailbox), ok = 0, failed = [];
    (a.ids || []).forEach(function (id) {
      try {
        var m = mb.messages.byId(Number(id));
        if (a.flagged) { m.flaggedStatus = true; if (a.color) m.flagIndex = COLORS[String(a.color).toLowerCase()]; }
        else { m.flaggedStatus = false; try { m.flagIndex = -1; } catch (e) {} }
        ok++;
      } catch (e) { failed.push(id); }
    });
    return { updated: ok, failed: failed };
  },
  forward_message: function (a) {
    var M = mail(), m = getMessage(a);
    var draft = a.draft !== false;
    var f = M.forward(m, { openingWindow: draft });
    addRecipients(f, 'toRecipients', M.ToRecipient, a.to);
    addRecipients(f, 'ccRecipients', M.CcRecipient, a.cc);
    addRecipients(f, 'bccRecipients', M.BccRecipient, a.bcc);
    if (a.body) {
      var orig = ''; try { orig = f.content() || ''; } catch (e) {}
      if (!orig) {
        orig = '---------- Forwarded message ----------\nFrom: ' + m.sender() + '\nDate: ' + (iso(m.dateReceived()) || '') +
          '\nSubject: ' + m.subject() + '\n\n' + (function () { try { return m.content(); } catch (e) { return ''; } })();
      }
      f.content = a.body + '\n\n' + orig;
    }
    if (draft) { M.activate(); return 'Forward opened in Mail — check it and press Send.'; }
    f.send();
    return 'Forwarded to: ' + toList(a.to).join(', ');
  },
  save_attachments: function (a) {
    var M = mail(), m = getMessage(a), dir = a.dir || SAVE_DIR;
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
    var want = a.names && a.names.length ? a.names : null, saved = [], skipped = [];
    m.mailAttachments().forEach(function (x) {
      var n = x.name();
      if (want && want.indexOf(n) < 0) return;
      try { var p = uniquePath(dir, n); M.save(x, { in: Path(p) }); saved.push(p); } catch (e) { skipped.push(n + ': ' + e.message); }
    });
    if (!saved.length && !skipped.length) throw new Error(want ? 'No attachments with those names' : 'Message has no attachments');
    return { saved: saved, failed: skipped };
  },
  list_calendars: function () {
    var C = cal();
    return C.calendars().map(function (c) { var w = true; try { w = c.writable(); } catch (e) {} return { name: c.name(), writable: w }; });
  },
  list_events: function (a) {
    var C = cal(), from = new Date(a.from), to = new Date(a.to), out = [];
    var cals = a.calendar ? [C.calendars.byName(a.calendar)] : C.calendars();
    cals.forEach(function (c) {
      var evs = c.events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] });
      var t = evs.summary(), s = evs.startDate(), e = evs.endDate(), l = evs.location(), u = evs.uid();
      for (var i = 0; i < t.length; i++) out.push({ uid: u[i], calendar: c.name(), title: t[i], start: iso(s[i]), end: iso(e[i]), location: l[i] });
    });
    out.sort(function (x, y) { return x.start < y.start ? -1 : 1; });
    return out;
  },
  create_event: function (a) {
    var C = cal(), target = null;
    if (a.calendar) target = C.calendars.byName(a.calendar);
    else {
      var all = C.calendars();
      for (var i = 0; i < all.length && !target; i++) { try { if (all[i].writable()) target = all[i]; } catch (e) {} }
      if (!target) target = all[0];
    }
    var props = { summary: a.title, startDate: new Date(a.start), endDate: new Date(a.end) };
    if (a.location) props.location = a.location;
    if (a.notes) props.description = a.notes;
    var ev = C.Event(props);
    target.events.push(ev);
    return 'Событие создано в календаре «' + target.name() + '»: ' + a.title + ', ' + a.start;
  },
  list_rules: function () {
    return mail().rules().map(function (r) {
      var mv = null; try { if (r.shouldMoveMessage()) { var mb = r.moveMessage(); mv = mb.account().name() + ' / ' + mb.name(); } } catch (e) {}
      return { name: r.name(), enabled: r.enabled(), match: r.allConditionsMustBeMet() ? 'all' : 'any',
        conditions: (function () { var cs = null; try { cs = r.ruleConditions(); } catch (e) {} return (cs || []).map(function (c) { return { type: c.ruleType(), qualifier: c.qualifier(), value: c.expression() }; }); })(),
        move_to: mv, mark_read: r.markRead(), delete: r.deleteMessage(), stop: r.stopEvaluatingRules() };
    });
  },
  create_mailbox: function (a) {
    var M = mail(), acc = getAccount(a.account);
    acc.mailboxes.push(M.Mailbox({ name: a.name }));
    acc.mailboxes.byName(a.name).name();
    return 'Folder created: ' + a.account + ' / ' + a.name;
  },
  move_messages: function (a) {
    var M = mail(), src = getMailbox(a.account, a.mailbox), dst = getMailbox(a.to_account || a.account, a.to_mailbox), ok = 0, failed = [];
    if (a.dry_run) return { dry_run: true, would_move_to: (a.to_account || a.account) + ' / ' + a.to_mailbox, messages: idsSummary(src, a.ids) };
    (a.ids || []).forEach(function (id) {
      try { M.move(src.messages.byId(Number(id)), { to: dst }); ok++; } catch (e) { failed.push(id); }
    });
    return { moved: ok, failed: failed, to: (a.to_account || a.account) + ' / ' + a.to_mailbox };
  },
  create_rule: function (a) {
    // Built via AppleScript: Mail's JXA bridge can't add rule conditions reliably.
    var FIELD = { from: 'from header', to: 'to header', cc: 'cc header', subject: 'subject header', any_recipient: 'any recipient', content: 'message content' };
    var OP = { contains: 'does contain value', not_contains: 'does not contain value', begins: 'begins with value', ends: 'ends with value', equals: 'equal to value' };
    if (!a.name) throw new Error('name is required');
    if (!a.conditions || !a.conditions.length) throw new Error('At least one condition is required');
    a.conditions.forEach(function (c) {
      if (!FIELD[c.field]) throw new Error('Unknown field "' + c.field + '". Use: ' + Object.keys(FIELD).join(', '));
      if (c.op && !OP[c.op]) throw new Error('Unknown op "' + c.op + '". Use: ' + Object.keys(OP).join(', '));
    });
    if (a.move_to) getMailbox(a.move_to.account, a.move_to.mailbox); // validate target exists
    try { mail().rules.byName(a.name).name(); throw new Error('exists'); } catch (e) {
      if (e.message === 'exists') throw new Error('A rule named "' + a.name + '" already exists');
    }
    function q(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
    var props = ['name:' + q(a.name), 'enabled:false', 'all conditions must be met:' + ((a.match || 'all') === 'all')];
    if (a.move_to) props.push('should move message:true', 'move message:(mailbox ' + q(a.move_to.mailbox) + ' of account ' + q(a.move_to.account) + ')');
    if (a.mark_read) props.push('mark read:true');
    if (a.flag) props.push('mark flagged:true');
    if (a.delete) props.push('delete message:true');
    if (a.stop) props.push('stop evaluating rules:true');
    var lines = ['tell application "Mail"',
      '  set r to make new rule at end of rules with properties {' + props.join(', ') + '}',
      '  tell r'];
    // Mail may add a default condition to a new rule; drop it first
    lines.push('    delete every rule condition');
    a.conditions.forEach(function (c) {
      lines.push('    make new rule condition at end of rule conditions with properties {rule type:' + FIELD[c.field] +
        ', qualifier:' + OP[c.op || 'contains'] + ', expression:' + q(c.value) + '}');
    });
    lines.push('  end tell',
      '  if (count of rule conditions of r) is not ' + a.conditions.length + ' then',
      '    delete r',
      '    error "Could not set rule conditions; rule removed"',
      '  end if');
    if (a.enabled !== false) lines.push('  set enabled of r to true');
    lines.push('end tell');
    var app = Application.currentApplication();
    app.includeStandardAdditions = true;
    app.runScript(lines.join('\n'), { in: 'AppleScript' });
    return HANDLERS.list_rules().filter(function (x) { return x.name === a.name; })[0];
  },
  set_rule_enabled: function (a) { var r = mail().rules.byName(a.name); r.name(); r.enabled = !!a.enabled; return 'ok'; },
  delete_rule: function (a) { var M = mail(), r = M.rules.byName(a.name); r.name(); M.delete(r); return 'Rule deleted: ' + a.name; },
  list_note_folders: function () {
    return notes().accounts().map(function (acc) {
      return { account: acc.name(), folders: acc.folders().map(function (f) {
        var n = 0; try { n = f.notes.length; } catch (e) {} return { folder: f.name(), notes: n }; }) };
    });
  },
  list_notes: function (a) {
    var spec = a.folder ? noteFolder(a.account, a.folder).notes : notes().notes;
    // an explicitly requested folder is shown as is (even Recently Deleted)
    return noteSummary(spec, a.limit || 30, !!a.folder || !!a.include_deleted);
  },
  search_notes: function (a) {
    var q = String(a.query);
    var spec = notes().notes.whose({ _or: [{ name: { _contains: q } }, { plaintext: { _contains: q } }] });
    return noteSummary(spec, a.limit || 20, !!a.include_deleted);
  },
  read_note: function (a) {
    var n = getNote(a.id), r = { id: a.id, title: n.name() };
    try { r.folder = n.container().name(); } catch (e) {}
    try { r.created = iso(n.creationDate()); r.modified = iso(n.modificationDate()); } catch (e) {}
    try { r.locked = n.passwordProtected(); } catch (e) {}
    if (r.locked) { r.body = null; r.note = 'Note is locked; unlock it in Notes first.'; return r; }
    r.body = clip(a.html ? n.body() : n.plaintext(), 60000);
    return r;
  },
  create_note: function (a) {
    var N = notes();
    var target = a.folder ? noteFolder(a.account, a.folder) : (a.account ? N.accounts.byName(a.account).defaultFolder() : N.defaultAccount().defaultFolder());
    var html = '<div><h1>' + esc(a.title) + '</h1></div>' + (a.body ? toNoteHtml(a.body, a.html) : '');
    var n = N.Note({ body: html });
    target.notes.push(n);
    var made = target.notes.whose({ name: a.title })();
    var id = made.length ? made[made.length - 1].id() : null;
    return { created: true, id: id, title: a.title, folder: target.name() };
  },
  update_note: function (a) {
    var n = getNote(a.id);
    try { if (n.passwordProtected()) throw new Error('Note is locked'); } catch (e) { if (e.message === 'Note is locked') throw e; }
    var add = toNoteHtml(a.body, a.html);
    if (a.append) n.body = n.body() + add;
    else n.body = '<div><h1>' + esc(a.title || n.name()) + '</h1></div>' + add;
    return { updated: true, id: a.id, title: n.name() };
  },
  delete_note: function (a) { var N = notes(), n = getNote(a.id), t = n.name(); N.delete(n); return 'Deleted (Recently Deleted): ' + t; },
  delete_event: function (a) {
    var C = cal(), cals = a.calendar ? [C.calendars.byName(a.calendar)] : C.calendars(), n = 0;
    cals.forEach(function (c) {
      var evs; try { evs = c.events.whose({ uid: a.uid })(); } catch (e) { return; }
      evs.forEach(function (ev) { C.delete(ev); n++; });
    });
    if (!n) throw new Error('Событие с uid ' + a.uid + ' не найдено');
    return 'Удалено событий: ' + n;
  },
  delete_messages: function (a) {
    var M = mail(), mb = getMailbox(a.account, a.mailbox), ok = 0, failed = [];
    if (a.dry_run) return { dry_run: true, would_move_to_trash: idsSummary(mb, a.ids) };
    (a.ids || []).forEach(function (id) {
      try { M.delete(mb.messages.byId(Number(id))); ok++; } catch (e) { failed.push(id); }
    });
    return { moved_to_trash: ok, failed: failed };
  }
};

// ---------- two public tools: read / write ----------
var READ_ACTIONS = ['list_accounts', 'list_mailboxes', 'list_messages', 'search_messages', 'read_message',
  'awaiting_reply', 'needs_response', 'get_thread', 'list_attachments', 'list_rules', 'list_calendars', 'list_events',
  'list_note_folders', 'list_notes', 'search_notes', 'read_note'];
var WRITE_ACTIONS = ['send_email', 'reply_message', 'forward_message', 'set_read', 'set_flag', 'save_attachments', 'delete_messages', 'create_mailbox', 'move_messages',
  'create_rule', 'set_rule_enabled', 'delete_rule', 'create_event', 'delete_event',
  'create_note', 'update_note', 'delete_note'];

function describe(actions) {
  return actions.map(function (n) {
    var t = TOOLS.filter(function (x) { return x.name === n; })[0];
    var props = t.inputSchema.properties || {}, req = t.inputSchema.required || [];
    var args = Object.keys(props).map(function (k) {
      return k + (req.indexOf(k) >= 0 ? '*' : '') + ':' + (props[k].type || '') + (props[k].description ? ' (' + props[k].description + ')' : '');
    }).join(', ');
    return '• ' + n + ' — ' + t.description + (args ? ' Аргументы: ' + args : '');
  }).join('\n');
}
function publicTool(name, title, actions, annotations) {
  return { name: name, annotations: annotations,
    description: title + '\nУкажите action и args (объект). * — обязательный аргумент.\n' + describe(actions),
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: actions },
      args: { type: 'object', description: 'аргументы выбранного action' } }, required: ['action'] } };
}
var PUBLIC_TOOLS = [
  publicTool('read', 'Read Apple Mail, Calendar and Notes (never changes anything).', READ_ACTIONS,
    { title: 'Read mail, calendar & notes', readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  publicTool('write', 'Change Apple Mail, Calendar and Notes: send, reply, organize mail, rules, events, notes.', WRITE_ACTIONS,
    { title: 'Change mail, calendar & notes', readOnlyHint: false, destructiveHint: true, openWorldHint: true })
];
if (READ_ONLY) PUBLIC_TOOLS = PUBLIC_TOOLS.filter(function (t) { return t.name === 'read'; });
function callPublic(name, a) {
  if (name === 'write' && READ_ONLY) throw new Error('Read-only mode is on (extension settings) — changes are disabled.');
  var allowed = name === 'read' ? READ_ACTIONS : name === 'write' ? WRITE_ACTIONS : null;
  if (!allowed) throw new Error('Нет такого инструмента: ' + name);
  if (allowed.indexOf(a.action) < 0) throw new Error('action "' + a.action + '" недоступен в ' + name + '. Доступно: ' + allowed.join(', '));
  return HANDLERS[a.action](a.args || {});
}

// ---------- JSON-RPC ----------
function handle(req) {
  var id = req.id, method = req.method, p = req.params || {};
  var isNotification = (id === undefined || id === null);
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id: id, result: {
        protocolVersion: p.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'apple-mail-jxa', version: '1.3.1' } } });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id: id, result: { tools: PUBLIC_TOOLS } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id: id, result: {} });
    if (method === 'tools/call') {
      var out;
      try {
        var res = callPublic(p.name, p.arguments || {});
        out = { content: [{ type: 'text', text: typeof res === 'string' ? res : JSON.stringify(res, null, 1) }] };
      } catch (e) {
        out = { isError: true, content: [{ type: 'text', text: 'Ошибка: ' + (e && e.message ? e.message : String(e)) }] };
      }
      return send({ jsonrpc: '2.0', id: id, result: out });
    }
    if (isNotification) return; // notifications/initialized etc.
    send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    if (!isNotification) send({ jsonrpc: '2.0', id: id, error: { code: -32603, message: String(e) } });
  }
}

var CANCELLED = {};
function run() {
  var stdin = $.NSFileHandle.fileHandleWithStandardInput;
  var buf = $.NSMutableData.alloc.init;
  log('started');
  while (true) {
    var chunk = stdin.availableData;
    if (!chunk || chunk.length === 0) break; // EOF
    buf.appendData(chunk);
    var str = $.NSString.alloc.initWithDataEncoding(buf, $.NSUTF8StringEncoding);
    if (!str || str.isNil()) continue; // partial UTF-8 sequence, wait for more
    str = str.js;
    var nl = str.lastIndexOf('\n');
    if (nl < 0) continue;
    var complete = str.slice(0, nl), rest = str.slice(nl + 1);
    buf = $.NSMutableData.alloc.init;
    if (rest.length) buf.appendData($(rest).dataUsingEncoding($.NSUTF8StringEncoding));
    // Handlers are synchronous Apple Events and cannot be interrupted, but a request that is
    // still waiting in the pipe can be dropped: read the whole chunk, note cancellations, then run.
    var reqs = [];
    complete.split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      try { reqs.push(JSON.parse(line)); } catch (e) { log('bad json: ' + line.slice(0, 200)); }
    });
    reqs.forEach(function (r) {
      if (r.method === 'notifications/cancelled' && r.params && r.params.requestId != null) CANCELLED[String(r.params.requestId)] = true;
    });
    reqs.forEach(function (r) {
      if (r.method === 'notifications/cancelled') return;
      if (r.id != null && CANCELLED[String(r.id)]) { delete CANCELLED[String(r.id)]; log('skipped cancelled request ' + r.id); return; }
      handle(r);
    });
  }
  log('stdin closed, exiting');
}
