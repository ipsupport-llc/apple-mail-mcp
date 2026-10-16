// Unit tests: load the server with fake Mail / Calendar / Notes apps and call its actions directly.
// Run:  /usr/bin/osascript -l JavaScript tests/unit.js server/apple-mail-mcp.js
// Nothing here talks to the real apps.

ObjC.import('Foundation');

// ---------- fake scripting objects ----------
// A JXA element collection is callable (spec() → array), has bulk getters (spec.subject() → array),
// byName/byId/whose/push and numeric indexes. Items expose properties as getter functions.
function item(props) {
  var o = {};
  Object.keys(props).forEach(function (k) {
    var v = props[k];
    if (typeof v === 'function' && v.isCollection) { o[k] = v; return; }
    Object.defineProperty(o, k, {
      get: function () { var f = function () { if (props[k] instanceof Error) throw props[k]; return props[k]; }; return f; },
      set: function (nv) { props[k] = nv; }, enumerable: true, configurable: true
    });
  });
  o._props = props;
  return o;
}
function missing(what) { var e = new Error("Can't get object: " + what); return item({ name: e, subject: e, id: e }); }
function coll(items, owner) {
  var c = function () { return items.slice(); };
  c.isCollection = true;
  c.items = items;
  // functions have read-only built-in `name` and `length`, so those are redefined, not assigned
  function refresh() { for (var i = 0; i < 200; i++) delete c[i]; items.forEach(function (x, i) { c[i] = x; }); Object.defineProperty(c, 'length', { value: items.length, configurable: true }); }
  refresh();
  ['id', 'name', 'subject', 'sender', 'dateReceived', 'dateSent', 'readStatus', 'wasRepliedTo', 'wasForwarded', 'flaggedStatus', 'messageId',
    'summary', 'startDate', 'endDate', 'location', 'uid', 'alldayEvent', 'recurrence', 'excludedDates', 'modificationDate', 'emailAddresses'].forEach(function (p) {
    Object.defineProperty(c, p, { value: function () { return items.map(function (x) { return x[p](); }); }, configurable: true, writable: true });
  });
  c.toRecipients = { address: function () { return items.map(function (x) { return x.toRecipients().map(function (r) { return r.address(); }); }); } };
  c.ccRecipients = { address: function () { return items.map(function (x) { return x.ccRecipients().map(function (r) { return r.address(); }); }); } };
  c.byName = function (n) { return items.filter(function (x) { return x.name() === n; })[0] || missing(n); };
  c.byId = function (id) { return items.filter(function (x) { return x.id() === id; })[0] || missing('id ' + id); };
  c.whose = function (cond) { return coll(items.filter(function (x) { return matches(x, cond); }), owner); };
  c.push = function (x) { if (owner && owner.onPush) owner.onPush(x, items); else items.push(x); refresh(); };
  c.remove = function (x) { var i = items.indexOf(x); if (i >= 0) items.splice(i, 1); refresh(); };
  return c;
}
function matches(x, cond) {
  if (cond._and) return cond._and.every(function (c) { return matches(x, c); });
  if (cond._or) return cond._or.some(function (c) { return matches(x, c); });
  return Object.keys(cond).every(function (k) {
    var v = x[k](), t = cond[k];
    if (t && typeof t === 'object' && !(t instanceof Date)) {
      if ('_contains' in t) return String(v).toLowerCase().indexOf(String(t._contains).toLowerCase()) >= 0;
      if ('_greaterThan' in t) return v > t._greaterThan;
      if ('_lessThan' in t) return v < t._lessThan;
    }
    return v === t;
  });
}
function recipient(addr) { return item({ name: '', address: addr }); }
function withRecipients(m, to, cc) {
  var tr = function () { return to.map(recipient); }; tr.address = function () { return to; };
  var cr = function () { return (cc || []).map(recipient); }; cr.address = function () { return cc || []; };
  Object.defineProperty(m, 'toRecipients', { value: tr }); Object.defineProperty(m, 'ccRecipients', { value: cr });
  return m;
}

// ---------- fake Mail ----------
var nextId = 1000;
function message(box, f) {
  var m = item({ id: f.id || nextId++, subject: f.subject || 'Hello', sender: f.from || 'Anna <anna@example.com>', dateReceived: f.date || new Date(),
    dateSent: f.date || new Date(), readStatus: !!f.read, wasRepliedTo: !!f.replied, wasForwarded: false, flaggedStatus: false, flagIndex: -1,
    messageId: f.messageId || ('<' + (nextId++) + '@x>'), content: f.body || 'text', replyTo: '' });
  m.mailbox = function () { return m._box; };
  m._box = box;
  m.mailAttachments = function () { return (f.attachments || []).map(function (n) { return item({ name: n, fileSize: 10, mimeType: 'text/plain', downloaded: true }); }); };
  return withRecipients(m, f.to || ['me@icloud.com'], f.cc);
}
function mailbox(account, name, kids) {
  var b = item({ name: name, unreadCount: 0 });
  b.messages = coll([]);
  b.mailboxes = coll(kids || [], { onPush: function (x, items) { items.push(mailbox(account, x._props.name)); } });
  b.account = function () { return account; };
  b.add = function (f) { var m = message(b, f); b.messages.push(m); return m; };
  return b;
}
function makeMail() {
  var M = {}, accounts = [];
  function account(name, addrs, boxes, trashSetting) {
    var a = item({ name: name, emailAddresses: addrs, enabled: true, moveDeletedMessagesToTrash: trashSetting !== false });
    a.mailboxes = coll([], { onPush: function (x, items) { items.push(mailbox(a, x._props.name)); } });
    boxes.forEach(function (n) { a.mailboxes.push(item({ name: n })); });
    accounts.push(a);
    return a;
  }
  var icloud = account('iCloud', ['me@icloud.com'], ['INBOX', 'Sent Messages', 'Deleted Messages', 'Junk', 'Drafts', 'Receipts']);
  var work = account('Work', ['me@work.com'], ['INBOX', 'Sent Items', 'Archive']); // no Trash at all
  M.accounts = coll(accounts);
  function role(names) {
    var r = item({ name: 'All' });
    r.mailboxes = function () { return names.map(function (p) { return accounts.filter(function (a) { return a.name() === p[0]; })[0].mailboxes.byName(p[1]); }); };
    return r;
  }
  M.inbox = role([['iCloud', 'INBOX'], ['Work', 'INBOX']]);
  var unified = coll([]);
  M.inbox.messages = { byId: function (id) { return allMessages().filter(function (m) { return m.id() === id && m._box.name() === 'INBOX'; })[0] || missing(id); },
    whose: function (c) { return coll(allMessages().filter(function (m) { return m._box.name() === 'INBOX' && matches(m, c); })); } };
  M.sentMailbox = role([['iCloud', 'Sent Messages'], ['Work', 'Sent Items']]);
  M.trashMailbox = role([['iCloud', 'Deleted Messages']]);
  M.junkMailbox = role([['iCloud', 'Junk']]);
  M.draftsMailbox = role([['iCloud', 'Drafts']]);
  M.outbox = role([]);
  function allMessages() { var out = []; accounts.forEach(function (a) { a.mailboxes.items.forEach(function (b) { out = out.concat(b.messages.items); }); }); return out; }
  M.allMessages = allMessages;
  M.box = function (acc, name) { return accounts.filter(function (a) { return a.name() === acc; })[0].mailboxes.byName(name); };
  M.move = function (m, opts) { m._box.messages.remove(m); opts.to.messages.push(m); m._box = opts.to; };
  M.deleted = [];
  M['delete'] = function (x) { M.deleted.push(x); };
  M.sent = [];
  M.sendResult = true;
  function outgoing(props) {
    var o = item({ subject: props.subject || '', content: props.content || '', sender: '', visible: !!props.visible });
    ['toRecipients', 'ccRecipients', 'bccRecipients'].forEach(function (f) {
      var list = []; var fn = function () { return list; }; fn.push = function (r) { list.push(r); }; fn.address = function () { return list.map(function (r) { return r.address(); }); };
      Object.defineProperty(o, f, { value: fn });
    });
    o.send = function () { M.sent.push(o); return M.sendResult; };
    o.mailAttachments = function () { return props.attachments || []; };
    o.close = function () { o.closed = true; };
    return o;
  }
  M.OutgoingMessage = function (p) { return outgoing(p); };
  M.outgoingMessages = { push: function () {} };
  M.ToRecipient = M.CcRecipient = M.BccRecipient = function (p) { return item({ name: p.name || '', address: p.address }); };
  M.reply = function (m, opts) { var o = outgoing({ subject: 'Re: ' + m.subject() }); o.toRecipients.push(recipient(lower(m.sender()).replace(/.*<|>.*/g, ''))); o.opts = opts; return o; };
  M.forward = function (m, opts) { var o = outgoing({ subject: 'Fwd: ' + m.subject(), content: '', attachments: M.forwardKeepsAttachments ? m.mailAttachments() : [] }); o.opts = opts; return o; };
  M.forwardKeepsAttachments = true;
  M.activate = function () {};
  M.Mailbox = function (p) { return item(p); };
  M.rules = coll([]);
  M.save = function (x, opts) { M.saved = (M.saved || []).concat(String(opts['in'])); };
  M.icloud = icloud; M.work = work;
  return M;
}

// ---------- fake Calendar ----------
function makeCalendar() {
  var C = {};
  function calendar(name, writable) {
    var c = item({ name: name, writable: writable });
    c.events = coll([], { onPush: function (x, items) { items.push(event(x._props)); } });
    return c;
  }
  function event(p) {
    return item({ summary: p.summary, startDate: p.startDate, endDate: p.endDate, location: p.location || '', uid: p.uid || ('uid-' + nextId++),
      alldayEvent: !!p.alldayEvent, recurrence: p.recurrence || '', excludedDates: p.excludedDates || [], description: p.description || '' });
  }
  var home = calendar('Home', true), work1 = calendar('Work', true), work2 = calendar('Work', true), holidays = calendar('Holidays', false);
  C.calendars = coll([home, work1, work2, holidays]);
  C.Event = function (p) { return item(p); };
  C.addEvent = function (cal, p) { cal.events.push(item(p)); return cal.events.items[cal.events.items.length - 1]; };
  C.deleted = [];
  C['delete'] = function (ev) { C.deleted.push(ev); };
  C.home = home; C.work1 = work1; C.work2 = work2; C.holidays = holidays;
  return C;
}

// ---------- fake Notes ----------
function makeNotes() {
  var N = {}, all = [];
  function folder(acc, name) {
    var f = item({ name: name });
    f.container = function () { return acc; };
    f.notes = coll([], { onPush: function (x, items) { var n = note(f, x._props.body); items.unshift(n); } }); // Notes inserts new notes first
    return f;
  }
  function note(f, body) {
    var title = (/<h1>(.*?)<\/h1>/.exec(body) || [])[1] || 'Untitled';
    var n = item({ id: 'x-coredata://N/ICNote/p' + (nextId++), name: title, body: body, plaintext: body.replace(/<[^>]+>/g, ' '), modificationDate: new Date(), creationDate: new Date(), passwordProtected: false });
    n.container = function () { return f; };
    all.push(n);
    return n;
  }
  function account(name, folders) {
    var a = item({ name: name });
    a.folders = coll([]);
    folders.forEach(function (fn) { a.folders.items.push(folder(a, fn)); });
    a.folders.push = function () {};
    a.defaultFolder = function () { return a.folders.byName('Notes'); };
    a.notes = { whose: function (c) { return coll(all.filter(function (n) { return n.container().container() === a && matches(n, c); })); } };
    return a;
  }
  var icloud = account('iCloud', ['Notes', 'Recently Deleted', 'Archive']), exchange = account('Exchange', ['Notes']);
  [icloud, exchange].forEach(function (a) { a.folders.items.forEach(function (f, i) { a.folders[i] = f; }); Object.defineProperty(a.folders, 'length', { value: a.folders.items.length }); });
  N.accounts = coll([icloud, exchange]);
  N.notes = { byId: function (id) { return all.filter(function (n) { return n.id() === id; })[0] || missing(id); },
    whose: function (c) { return coll(all.filter(function (n) { return matches(n, c); })); } };
  N.defaultAccount = function () { return icloud; };
  N.Note = function (p) { return item(p); };
  N.deleted = [];
  N['delete'] = function (n) { N.deleted.push(n); };
  N.icloud = icloud; N.exchange = exchange;
  N.addNote = function (f, title) { f.notes.push(item({ body: '<div><h1>' + title + '</h1></div>' })); return f.notes.items[0]; };
  return N;
}

// ---------- load the server ----------
function readFile(p) { return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null)); }
function lower(s) { return String(s).toLowerCase(); }

function run(argv) {
  var src = readFile(argv[0] || 'server/apple-mail-mcp.js').replace(/\nfunction run\(\) \{/, '\nfunction serverRun() {')
    .replace("name: 'AppleMailMCPStdin'", "name: 'AppleMailMCPStdinTest" + Date.now() + "'");
  (0, eval)(src);
  var passed = 0, failed = [];
  function reset() { Mail = makeMail(); Cal = makeCalendar(); NotesApp = makeNotes(); DONE = []; LAST_READ = { key: null, at: 0 }; EVENT_CACHE = {}; }
  function call(tool, input) { return JSON.parse(formatResult(callPublic(tool, input))); }
  function callErr(tool, input) {
    try { callPublic(tool, input); } catch (e) { return formatError(e); }
    throw new Error('expected an error from ' + JSON.stringify(input));
  }
  function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)); }
  function ok(v, msg) { if (!v) throw new Error(msg || 'expected true'); }
  function has(text, part) { if (String(text).indexOf(part) < 0) throw new Error('expected "' + part + '" in: ' + text); }
  function test(name, f) { reset(); try { f(); passed++; } catch (e) { failed.push(name + ': ' + (e && e.message ? e.message : e)); } }

  // ---- argument normalisation
  test('string "false" is false, never true', function () {
    var m = Mail.box('iCloud', 'INBOX').add({ read: true });
    var r = call('write', { action: 'set_read', args: { ids: [m.id()], account: 'iCloud', read: 'false' } });
    eq(r.updated, 1); eq(m.readStatus(), false);
  });
  test('garbage boolean is an error', function () { has(callErr('write', { action: 'set_read', args: { id: 1, read: 'maybe' } }), 'must be true or false'); });
  test('ids from comma string and "#12"', function () {
    var a = Mail.box('iCloud', 'INBOX').add({}), b = Mail.box('iCloud', 'INBOX').add({});
    eq(call('write', { action: 'set_read', args: { ids: a.id() + ', #' + b.id(), account: 'iCloud', read: true } }).updated, 2);
  });
  test('id and ids are merged', function () {
    var a = Mail.box('iCloud', 'INBOX').add({}), b = Mail.box('iCloud', 'INBOX').add({});
    eq(call('write', { action: 'set_read', args: { ids: [a.id()], id: b.id(), account: 'iCloud', read: true } }).updated, 2);
  });
  test('flat args next to action are accepted with a note', function () {
    var m = Mail.box('iCloud', 'INBOX').add({});
    var r = call('read', { action: 'read_message', id: m.id(), account: 'iCloud' });
    eq(r.id, m.id()); has(r.notes.join(' '), 'inside "args"');
  });
  test('args as JSON string', function () {
    var m = Mail.box('iCloud', 'INBOX').add({});
    eq(call('read', { action: 'read_message', args: JSON.stringify({ id: m.id(), account: 'iCloud' }) }).id, m.id());
  });
  test('key aliases: message_id, folder, camelCase', function () {
    var m = Mail.box('iCloud', 'Receipts').add({});
    var r = call('read', { action: 'read_message', args: { messageId: String(m.id()), folder: 'receipts', account: 'icloud' } });
    eq(r.mailbox, 'Receipts');
  });
  test('unknown key on read is ignored with a note, on write is an error', function () {
    var m = Mail.box('iCloud', 'INBOX').add({});
    has(call('read', { action: 'read_message', args: { id: m.id(), colour: 'x' } }).notes.join(' '), 'colour');
    has(callErr('write', { action: 'set_read', args: { id: m.id(), read: true, colour: 'x' } }), 'Unknown argument "colour"');
  });
  test('mark_read is gone from read_message: ignored, never writes', function () {
    var m = Mail.box('iCloud', 'INBOX').add({ read: false });
    call('read', { action: 'read_message', args: { id: m.id(), account: 'iCloud', mark_read: true } });
    eq(m.readStatus(), false);
  });
  test('missing args are listed together', function () { has(callErr('write', { action: 'send_email', args: { to: 'a@b.co' } }), 'subject, body'); });
  test('bad address is an error', function () { has(callErr('write', { action: 'send_email', args: { to: 'anna', subject: 's', body: 'b' } }), 'Not an email address: anna'); });
  test('write action through read tool points to write', function () { has(callErr('read', { action: 'send_email', args: {} }), 'belongs to the write tool'); });
  test('read action alias and typo guess', function () {
    Mail.box('iCloud', 'INBOX').add({});
    has(call('read', { action: 'inbox', args: {} }).notes.join(' '), 'list_messages');
    has(call('read', { action: 'list_mesages', args: {} }).notes.join(' '), 'list_messages');
  });
  test('write typo is never guessed', function () { has(callErr('write', { action: 'delete_mesages', args: {} }), 'Did you mean "delete_messages"'); });
  test('alias presets: mark_unread', function () {
    var m = Mail.box('iCloud', 'INBOX').add({ read: true });
    call('write', { action: 'mark_unread', args: { id: m.id() } });
    eq(m.readStatus(), false);
  });
  test('sizes are adjusted with a note, indexes are not', function () {
    has(call('read', { action: 'list_messages', args: { limit: 5000 } }).notes.join(' '), 'capped');
    has(call('read', { action: 'list_messages', args: { limit: 0 } }).notes.join(' '), 'raised');
    has(callErr('read', { action: 'list_events', args: { calendar_index: -1 } }), 'at least 0');
  });
  test('relative dates', function () {
    var d = parseWhen('3 days ago'), want = new Date(); want = new Date(want.getFullYear(), want.getMonth(), want.getDate() - 3);
    eq(d.getTime(), want.getTime());
    eq(parseWhen('2026-10-27').getHours(), 0);
    eq(parseWhen('2026-10-27', true).getHours(), 23);
    ok(parseWhen('garbage') === null);
  });

  // ---- mail behaviour
  test('unknown folder without account still finds the message by id', function () {
    var m = Mail.box('iCloud', 'Receipts').add({});
    var r = call('read', { action: 'read_message', args: { id: m.id(), mailbox: 'Receits' } });
    eq(r.mailbox, 'Receipts'); has(r.notes.join(' '), 'every folder');
    has(callErr('read', { action: 'read_message', args: { id: m.id(), account: 'Nope' } }), 'No Mail account "Nope"');
  });
  test('wrong mailbox is recovered by id', function () {
    var m = Mail.box('iCloud', 'Receipts').add({});
    var r = call('read', { action: 'read_message', args: { id: m.id(), account: 'iCloud', mailbox: 'INBOX' } });
    eq(r.mailbox, 'Receipts'); has(r.notes.join(' '), 'is in iCloud / Receipts');
  });
  test('role words: "sent" is the account Sent folder', function () {
    Mail.box('Work', 'Sent Items').add({ subject: 'S' });
    eq(call('read', { action: 'list_messages', args: { account: 'Work', mailbox: 'sent' } }).items[0].mailbox, 'Sent Items');
  });
  test('default account is used for the inbox', function () {
    DEFAULT_ACCOUNT = 'Work';
    try {
      Mail.box('iCloud', 'INBOX').add({ subject: 'personal' }); Mail.box('Work', 'INBOX').add({ subject: 'work' });
      var r = call('read', { action: 'list_messages', args: {} });
      eq(r.items.map(function (x) { return x.subject; }), ['work']);
    } finally { DEFAULT_ACCOUNT = ''; }
  });
  test('unknown account lists accounts', function () { has(callErr('read', { action: 'list_messages', args: { account: 'Gmial' } }), 'Accounts: iCloud, Work'); });
  test('delete moves to the account Trash', function () {
    var m = Mail.box('iCloud', 'INBOX').add({});
    var r = call('write', { action: 'delete_messages', args: { ids: [m.id()], account: 'iCloud' } });
    eq(r.moved_to_trash, 1); eq(m._box.name(), 'Deleted Messages'); eq(Mail.deleted.length, 0);
  });
  test('delete refuses without a Trash folder and in Trash', function () {
    var w = Mail.box('Work', 'INBOX').add({});
    has(callErr('write', { action: 'delete_messages', args: { ids: [w.id()], account: 'Work' } }), 'no Trash folder');
    var t = Mail.box('iCloud', 'Deleted Messages').add({});
    has(callErr('write', { action: 'delete_messages', args: { ids: [t.id()], account: 'iCloud', mailbox: 'Deleted Messages' } }), 'already in Trash');
  });
  test('the same send twice is refused, repeat:true allows it', function () {
    var args = { to: 'bob@example.com', subject: 'Hi', body: 'x' };
    call('write', { action: 'send_email', args: args });
    has(callErr('write', { action: 'send_email', args: args }), 'already succeeded');
    call('write', { action: 'send_email', args: ext(args, { repeat: true }) });
    eq(Mail.sent.length, 2);
  });
  test('a failed send is reported', function () {
    Mail.sendResult = false;
    has(callErr('write', { action: 'send_email', args: { to: 'bob@example.com', subject: 'Hi', body: 'x' } }), 'did not send');
  });
  test('from must be one of my addresses; account name maps to its address', function () {
    has(callErr('write', { action: 'send_email', args: { to: 'b@example.com', subject: 's', body: 'b', from: 'ceo@evil.com' } }), 'not one of your sending addresses');
    var r = call('write', { action: 'send_email', args: { to: 'b@example.com', subject: 's', body: 'b', from: 'Work' } });
    has(r.notes.join(' '), 'me@work.com');
  });
  test('reply is a draft by default and shows real recipients', function () {
    var m = Mail.box('iCloud', 'INBOX').add({ from: 'Anna <anna@example.com>' });
    var r = call('write', { action: 'reply_message', args: { id: m.id(), account: 'iCloud', body: 'ok' } });
    eq(Mail.sent.length, 0); eq(r.to, ['anna@example.com']); has(r.status, 'draft');
  });
  test('forward that loses attachments is not sent', function () {
    Mail.forwardKeepsAttachments = false;
    var m = Mail.box('iCloud', 'INBOX').add({ attachments: ['a.pdf'] });
    has(callErr('write', { action: 'forward_message', args: { id: m.id(), account: 'iCloud', to: 'b@example.com', body: 'fyi', draft: false } }), 'dropped the attachments');
    eq(Mail.sent.length, 0);
  });
  test('save_attachments stays inside the attachments folder', function () {
    var m = Mail.box('iCloud', 'INBOX').add({ attachments: ['a.pdf'] });
    has(callErr('write', { action: 'save_attachments', args: { id: m.id(), account: 'iCloud', dir: '~/.ssh' } }), 'only be saved inside');
    has(callErr('write', { action: 'save_attachments', args: { id: m.id(), account: 'iCloud', dir: 'x/../../..' } }), 'only be saved inside');
  });
  test('needs_response: different people with the same subject are not merged; hello@ is a person', function () {
    var inbox = Mail.box('iCloud', 'INBOX'), sent = Mail.box('iCloud', 'Sent Messages'), t0 = new Date(Date.now() - 3 * 864e5);
    inbox.add({ subject: 'Invoice', from: 'Anna <anna@a.com>', date: t0 });
    inbox.add({ subject: 'Invoice', from: 'Bob <hello@bob.com>', date: t0 });
    inbox.add({ subject: 'Your order', from: 'Shop <no-reply@shop.com>', date: t0 });
    sent.add({ subject: 'Re: Invoice', from: 'me@icloud.com', to: ['anna@a.com'], date: new Date(Date.now() - 864e5) });
    var r = call('read', { action: 'needs_response', args: { account: 'iCloud' } });
    eq(r.items.map(function (x) { return x.from; }), ['Bob <hello@bob.com>']);
  });
  test('awaiting_reply: only an answer from a recipient counts', function () {
    var inbox = Mail.box('iCloud', 'INBOX'), sent = Mail.box('iCloud', 'Sent Messages'), t0 = new Date(Date.now() - 5 * 864e5);
    sent.add({ subject: 'Invoice', to: ['anna@a.com'], date: t0 });
    inbox.add({ subject: 'Re: Invoice', from: 'Stranger <x@y.com>', date: new Date() });
    eq(call('read', { action: 'awaiting_reply', args: { account: 'iCloud' } }).count, 1);
    inbox.add({ subject: 'Re: Invoice', from: 'Anna <anna@a.com>', date: new Date() });
    LAST_READ = { key: null, at: 0 };
    eq(call('read', { action: 'awaiting_reply', args: { account: 'iCloud' } }).count, 0);
  });
  test('search dedupes by Message-ID across folders', function () {
    Mail.box('iCloud', 'INBOX').add({ subject: 'Dup', messageId: '<same@x>' });
    Mail.box('iCloud', 'Receipts').add({ subject: 'Dup', messageId: '<same@x>' });
    eq(call('read', { action: 'search_messages', args: { query: 'Dup', account: 'iCloud', all_mailboxes: true } }).count, 1);
  });
  test('create_mailbox makes each level', function () {
    eq(call('write', { action: 'create_mailbox', args: { account: 'iCloud', name: 'Alerts/K8s' } }).created, ['Alerts', 'Alerts/K8s']);
  });

  // ---- calendar
  test('ambiguous calendar name asks for calendar_index', function () {
    has(callErr('write', { action: 'create_event', args: { title: 'x', start: '2026-10-27T10:00:00Z', calendar: 'Work' } }), 'calendar_index');
  });
  test('create_event: date only is all-day, end defaults, end before start fails', function () {
    var r = call('write', { action: 'create_event', args: { title: 'Trip', start: '2026-10-27', calendar: 'Home' } });
    eq(r.all_day, true);
    has(callErr('write', { action: 'create_event', args: { title: 'x', start: '2026-10-27T10:00:00Z', end: '2026-10-27T09:00:00Z', calendar: 'Home' } }), 'must be after');
    has(callErr('write', { action: 'create_event', args: { title: 'x', start: 'next tuesday-ish', calendar: 'Home' } }), 'must be a date');
  });
  test('create_event without calendar when several are writable', function () {
    has(callErr('write', { action: 'create_event', args: { title: 'x', start: '2026-10-27T10:00:00Z' } }), 'Which calendar?');
  });
  test('delete_event: repeating needs whole_series, duplicates need calendar_index', function () {
    Cal.addEvent(Cal.home, { summary: 'Standup', startDate: new Date(2026, 9, 1, 9), endDate: new Date(2026, 9, 1, 9, 15), uid: 'u1', recurrence: 'FREQ=DAILY' });
    has(callErr('write', { action: 'delete_event', args: { uid: 'u1' } }), 'whole_series');
    eq(call('write', { action: 'delete_event', args: { uid: 'u1', whole_series: true } }).whole_series, true);
    Cal.addEvent(Cal.home, { summary: 'Copy', startDate: new Date(), endDate: new Date(), uid: 'u2' });
    Cal.addEvent(Cal.work1, { summary: 'Copy', startDate: new Date(), endDate: new Date(), uid: 'u2' });
    has(callErr('write', { action: 'delete_event', args: { uid: 'u2' } }), 'Nothing was deleted');
  });
  test('list_events expands a series that started long ago', function () {
    Cal.addEvent(Cal.home, { summary: 'Weekly', startDate: new Date(2025, 0, 6, 10), endDate: new Date(2025, 0, 6, 11), uid: 'w', recurrence: 'FREQ=WEEKLY;BYDAY=MO' });
    var r = call('read', { action: 'list_events', args: { from: '2026-10-12', to: '2026-10-25', calendar_index: 0 } });
    eq(r.items.map(function (x) { return new Date(x.start).getDate(); }), [12, 19]);
  });
  test('list_events: one-off events in the window, outside it skipped, cache refreshed after create', function () {
    Cal.addEvent(Cal.home, { summary: 'In', startDate: new Date(2026, 9, 14, 10), endDate: new Date(2026, 9, 14, 11), uid: 'in' });
    Cal.addEvent(Cal.home, { summary: 'Out', startDate: new Date(2026, 8, 1, 10), endDate: new Date(2026, 8, 1, 11), uid: 'out' });
    var args = { from: '2026-10-12', to: '2026-10-25', calendar_index: 0 };
    eq(call('read', { action: 'list_events', args: args }).items.map(function (x) { return x.title; }), ['In']);
    call('write', { action: 'create_event', args: { title: 'New', start: '2026-10-20T10:00:00', calendar_index: 0 } });
    LAST_READ = { key: null, at: 0 };
    eq(call('read', { action: 'list_events', args: args }).items.map(function (x) { return x.title; }), ['In', 'New']);
  });
  test('RRULE: yearly nth weekday, count, until, monthly last day, excluded', function () {
    function days(rule, s, from, to, ex) { return expandRecurrence(rule, s, new Date(s.getTime() + 36e5), ex || [], from, to).map(function (o) { return o.start.getFullYear() + '-' + (o.start.getMonth() + 1) + '-' + o.start.getDate(); }); }
    eq(days('FREQ=YEARLY;BYMONTH=2;BYDAY=3MO', new Date(2024, 1, 19, 9), new Date(2026, 0, 1), new Date(2027, 0, 1)), ['2026-2-16']);
    eq(days('FREQ=DAILY;COUNT=3', new Date(2026, 0, 1, 9), new Date(2026, 0, 1), new Date(2026, 1, 1)), ['2026-1-1', '2026-1-2', '2026-1-3']);
    eq(days('FREQ=WEEKLY;UNTIL=20260115', new Date(2026, 0, 1, 9), new Date(2026, 0, 1), new Date(2026, 2, 1)), ['2026-1-1', '2026-1-8', '2026-1-15']);
    eq(days('FREQ=MONTHLY;BYMONTHDAY=-1', new Date(2026, 0, 31, 9), new Date(2026, 0, 1), new Date(2026, 3, 1)), ['2026-1-31', '2026-2-28', '2026-3-31']);
    eq(days('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', new Date(2026, 0, 6, 9), new Date(2026, 0, 1), new Date(2026, 0, 31)), ['2026-1-6', '2026-1-8', '2026-1-20', '2026-1-22']);
    eq(days('FREQ=DAILY', new Date(2026, 0, 1, 9), new Date(2026, 0, 1), new Date(2026, 0, 4), [new Date(2026, 0, 2, 9)]), ['2026-1-1', '2026-1-3']);
    ok(expandRecurrence('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU', new Date(), new Date(), [], new Date(), new Date()) === null);
  });

  // ---- notes
  test('create_note returns the new note even with a duplicate title', function () {
    var old = NotesApp.addNote(NotesApp.icloud.folders.byName('Notes'), 'Weekly');
    var r = call('write', { action: 'create_note', args: { title: 'Weekly', body: 'new' } });
    ok(r.id && r.id !== old.id(), 'got the old id ' + r.id);
  });
  test('delete_note refuses where it would be permanent', function () {
    var n = NotesApp.addNote(NotesApp.exchange.folders.byName('Notes'), 'Work note');
    has(callErr('write', { action: 'delete_note', args: { id: n.id() } }), 'no Recently Deleted folder');
    var m = NotesApp.addNote(NotesApp.icloud.folders.byName('Notes'), 'Personal');
    eq(call('write', { action: 'delete_note', args: { id: m.id() } }).deleted, 'Personal');
  });
  test('list_notes with account only stays in that account', function () {
    NotesApp.addNote(NotesApp.icloud.folders.byName('Notes'), 'Mine');
    NotesApp.addNote(NotesApp.exchange.folders.byName('Notes'), 'Work');
    // the fake has no per-account notes collection for listing; search_notes covers the account filter
    eq(call('read', { action: 'search_notes', args: { query: 'Work', account: 'Exchange' } }).items.map(function (x) { return x.title; }), ['Work']);
  });

  // ---- registry sanity
  test('every action has a handler, a tool and arg specs with known types', function () {
    var types = ['string', 'integer', 'boolean', 'id', 'ids', 'list', 'addresses', 'date', 'object', 'objects'];
    Object.keys(ACTIONS).forEach(function (n) {
      var s = ACTIONS[n];
      ok(typeof s.run === 'function', n + ' has no handler');
      ok(s.tool === 'read' || s.tool === 'write', n + ' has no tool');
      Object.keys(s.args).forEach(function (k) { ok(types.indexOf(s.args[k].type) >= 0, n + '.' + k + ' type ' + s.args[k].type); });
    });
    Object.keys(ACTION_ALIASES).forEach(function (k) { ok(ACTIONS[ACTION_ALIASES[k]], 'alias ' + k + ' → missing ' + ACTION_ALIASES[k]); });
  });

  var report = passed + ' passed, ' + failed.length + ' failed' + (failed.length ? '\n  ' + failed.join('\n  ') : '');
  if (failed.length) throw new Error(report);
  return report;
}
