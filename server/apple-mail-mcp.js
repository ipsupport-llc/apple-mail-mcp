// Apple Mail MCP server — zero dependencies, runs on macOS built-in JXA.
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

// ---------- IO ----------
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function send(obj) {
  var s = JSON.stringify(obj) + '\n';
  stdout.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
}
function log(s) { console.log('[apple-mail-mcp] ' + s); } // stderr

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
  var idx = [];
  for (var i = 0; i < ids.length; i++) if (!unreadOnly || !read[i]) idx.push(i);
  idx.sort(function (x, y) { return (dates[y] || 0) - (dates[x] || 0); });
  idx = idx.slice(0, limit);
  return idx.map(function (i) {
    var acc = null, mbx = null;
    try { var mb = spec[i].mailbox(); mbx = mb.name(); acc = mb.account().name(); } catch (e) {}
    return { id: ids[i], account: acc, mailbox: mbx, date: iso(dates[i]), from: senders[i], subject: subs[i], read: read[i] };
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

// ---------- tools ----------
var TOOLS = [
  { name: 'list_accounts', description: 'Список почтовых аккаунтов Apple Mail и их адресов.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_mailboxes', description: 'Список папок (ящиков) аккаунта с числом непрочитанных.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] } },
  { name: 'list_messages', description: 'Последние письма в папке. Без account/mailbox — общий «Входящие».',
    inputSchema: { type: 'object', properties: {
      account: { type: 'string' }, mailbox: { type: 'string', description: 'по умолчанию INBOX' },
      limit: { type: 'number', description: 'по умолчанию 20' }, unread_only: { type: 'boolean' } } } },
  { name: 'search_messages', description: 'Поиск писем по теме и отправителю (подстрока). Без account/mailbox — во всех «Входящих».',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, account: { type: 'string' }, mailbox: { type: 'string' },
      limit: { type: 'number', description: 'по умолчанию 20' } }, required: ['query'] } },
  { name: 'read_message', description: 'Полный текст письма. id/account/mailbox берутся из list_messages или search_messages.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' },
      mark_read: { type: 'boolean', description: 'по умолчанию false' } }, required: ['id', 'account', 'mailbox'] } },
  { name: 'send_email', description: 'Отправить новое письмо. draft=true — только открыть окно письма в Mail без отправки.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'адреса через запятую' }, cc: { type: 'string' }, bcc: { type: 'string' },
      subject: { type: 'string' }, body: { type: 'string' },
      from: { type: 'string', description: 'адрес отправителя (один из адресов аккаунтов), необязательно' },
      draft: { type: 'boolean' } }, required: ['to', 'subject', 'body'] } },
  { name: 'reply_message', description: 'Ответить на письмо. draft=true — открыть ответ в Mail без отправки.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' },
      body: { type: 'string' }, reply_all: { type: 'boolean' }, draft: { type: 'boolean' } },
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
      to_mailbox: { type: 'string' }, to_account: { type: 'string', description: 'default: same account' } },
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
  { name: 'delete_event', description: 'Удалить событие календаря по uid (uid из list_events).',
    inputSchema: { type: 'object', properties: { uid: { type: 'string' }, calendar: { type: 'string' } }, required: ['uid'] } },
  { name: 'delete_messages', description: 'Переместить письма в Корзину (не безвозвратно). ids — список id из одной папки.',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'number' } }, account: { type: 'string' }, mailbox: { type: 'string' } },
      required: ['ids', 'account', 'mailbox'] } },
  { name: 'set_read', description: 'Пометить письмо прочитанным/непрочитанным.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'number' }, account: { type: 'string' }, mailbox: { type: 'string' }, read: { type: 'boolean' } },
      required: ['id', 'account', 'mailbox', 'read'] } }
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
    var q = String(a.query);
    var spec = getMailbox(a.account, a.mailbox).messages.whose({ _or: [
      { subject: { _contains: q } }, { sender: { _contains: q } } ] });
    return summarize(spec, a.limit || 20, false);
  },
  read_message: function (a) {
    var m = getMessage(a);
    var r = {
      id: m.id(), account: a.account, mailbox: a.mailbox, date: iso(m.dateReceived()),
      from: m.sender(), to: recips(m.toRecipients()), cc: recips(m.ccRecipients()),
      reply_to: m.replyTo(), subject: m.subject(), read: m.readStatus(),
      attachments: (function () { try { return m.mailAttachments().map(function (x) { return x.name(); }); } catch (e) { return []; } })(),
      body: clip(m.content(), 60000)
    };
    if (a.mark_read) m.readStatus = true;
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
    var r = M.reply(m, { openingWindow: !!a.draft, replyToAll: !!a.reply_all });
    r.content = a.body + quoted;
    if (a.draft) { M.activate(); return 'Ответ открыт в Mail — проверьте и нажмите «Отправить».'; }
    r.send();
    return 'Ответ отправлен на: ' + m.sender();
  },
  set_read: function (a) { getMessage(a).readStatus = !!a.read; return 'ok'; },
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
        conditions: r.ruleConditions().map(function (c) { return { type: c.ruleType(), qualifier: c.qualifier(), value: c.expression() }; }),
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
    (a.ids || []).forEach(function (id) {
      try { M.move(src.messages.byId(Number(id)), { to: dst }); ok++; } catch (e) { failed.push(id); }
    });
    return { moved: ok, failed: failed, to: (a.to_account || a.account) + ' / ' + a.to_mailbox };
  },
  create_rule: function (a) {
    var M = mail();
    var FIELD = { from: 'from header', to: 'to header', cc: 'cc header', subject: 'subject header', any_recipient: 'any recipient', content: 'message content' };
    var OP = { contains: 'does contain value', not_contains: 'does not contain value', begins: 'begins with value', ends: 'ends with value', equals: 'equal to value' };
    if (!a.conditions || !a.conditions.length) throw new Error('At least one condition is required');
    a.conditions.forEach(function (c) {
      if (!FIELD[c.field]) throw new Error('Unknown field "' + c.field + '". Use: ' + Object.keys(FIELD).join(', '));
      if (c.op && !OP[c.op]) throw new Error('Unknown op "' + c.op + '". Use: ' + Object.keys(OP).join(', '));
    });
    var dst = a.move_to ? getMailbox(a.move_to.account, a.move_to.mailbox) : null;
    M.rules.push(M.Rule({ name: a.name, enabled: false }));
    var r = M.rules.byName(a.name);
    // a fresh rule may come with a default condition — remove it so nothing broad slips through
    r.ruleConditions().forEach(function (c) { M.delete(c); });
    a.conditions.forEach(function (c) {
      r.ruleConditions.push(M.RuleCondition({ ruleType: FIELD[c.field], qualifier: OP[c.op || 'contains'], expression: c.value }));
    });
    r.allConditionsMustBeMet = (a.match || 'all') === 'all';
    if (dst) { r.moveMessage = dst; r.shouldMoveMessage = true; }
    if (a.mark_read) r.markRead = true;
    if (a.flag) r.markFlagged = true;
    if (a.delete) r.deleteMessage = true;
    if (a.stop) r.stopEvaluatingRules = true;
    if (r.ruleConditions().length !== a.conditions.length) { M.delete(r); throw new Error('Could not set rule conditions; rule removed'); }
    r.enabled = a.enabled !== false;
    return HANDLERS.list_rules().filter(function (x) { return x.name === a.name; })[0];
  },
  set_rule_enabled: function (a) { var r = mail().rules.byName(a.name); r.name(); r.enabled = !!a.enabled; return 'ok'; },
  delete_rule: function (a) { var M = mail(), r = M.rules.byName(a.name); r.name(); M.delete(r); return 'Rule deleted: ' + a.name; },
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
    (a.ids || []).forEach(function (id) {
      try { M.delete(mb.messages.byId(Number(id))); ok++; } catch (e) { failed.push(id); }
    });
    return { moved_to_trash: ok, failed: failed };
  }
};

// ---------- two public tools: read / write ----------
var READ_ACTIONS = ['list_accounts', 'list_mailboxes', 'list_messages', 'search_messages', 'read_message', 'list_rules', 'list_calendars', 'list_events'];
var WRITE_ACTIONS = ['send_email', 'reply_message', 'set_read', 'delete_messages', 'create_mailbox', 'move_messages',
  'create_rule', 'set_rule_enabled', 'delete_rule', 'create_event', 'delete_event'];

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
  publicTool('read', 'Read Apple Mail and Calendar (never changes anything).', READ_ACTIONS,
    { title: 'Read mail & calendar', readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  publicTool('write', 'Change Apple Mail and Calendar: send, reply, delete, create events.', WRITE_ACTIONS,
    { title: 'Send / change mail & calendar', readOnlyHint: false, destructiveHint: true, openWorldHint: true })
];
function callPublic(name, a) {
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
        serverInfo: { name: 'apple-mail-jxa', version: '1.1.0' } } });
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
    complete.split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var req;
      try { req = JSON.parse(line); } catch (e) { log('bad json: ' + line.slice(0, 200)); return; }
      handle(req);
    });
  }
  log('stdin closed, exiting');
}
