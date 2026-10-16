// Apple Mail, Calendar & Notes MCP server — zero dependencies, runs on macOS built-in JXA.
// Run:  /usr/bin/osascript -l JavaScript server/apple-mail-mcp.js
// Protocol: MCP over stdio (newline-delimited JSON-RPC 2.0). Logs go to stderr.
//
// Layout: config & IO → helpers → argument normalisation → Mail → Calendar → Notes →
// ACTIONS (the one registry of what the `read` and `write` tools do) → dispatch → JSON-RPC & stdio.
//
// Callers are often small local models, so arguments are normalised before use (aliases, "true" strings,
// comma lists, relative dates) and every mistake comes back as an error that says how to fix it.
// Anything that sends, deletes or creates is never guessed: unclear input there is an error, not a guess.

ObjC.import('Foundation');

var VERSION = '1.4.0'; // release.yml rewrites this from the tag

// ---------- IO ----------
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function send(obj) {
  var s = JSON.stringify(obj) + '\n';
  stdout.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
}
function log(s) { console.log('[apple-mail-mcp] ' + s); } // stderr

// ---------- config (Claude Desktop extension settings → env) ----------
function env(k) {
  try {
    var v = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey(k));
    return (v && String(v).indexOf('${') !== 0) ? String(v) : ''; // unset settings arrive as "${user_config.x}"
  } catch (e) { return ''; }
}
function stdPath(p) { return ObjC.unwrap($(String(p)).stringByExpandingTildeInPath.stringByStandardizingPath.stringByResolvingSymlinksInPath); }
var READ_ONLY = /^(1|true|yes)$/i.test(env('APPLE_MAIL_READ_ONLY'));
var DEFAULT_ACCOUNT = env('APPLE_MAIL_DEFAULT_ACCOUNT');
var SAVE_DIR = stdPath(env('APPLE_MAIL_SAVE_DIR') || '~/Downloads');

// ---------- errors, notes, small helpers ----------
// UserError: a mistake in the call. `hint` tells the model what to do instead.
function UserError(message, hint) { this.message = message; this.hint = hint || ''; }
function fail(message, hint) { throw new UserError(message, hint); }
function errorText(e) { return e && e.message ? e.message : String(e); }

var NOTES = []; // remarks for the model on how its call was read; reset per call
function note(s) { if (NOTES.indexOf(s) < 0) NOTES.push(s); }

function iso(d) { try { return d ? new Date(d).toISOString() : null; } catch (e) { return null; } }
function lower(s) { return String(s == null ? '' : s).toLowerCase(); }
function trim(s) { return String(s).trim(); }
function safe(f, fallback) { try { return f(); } catch (e) { if (e instanceof Cancelled) throw e; return fallback; } }
function exists(ref) { return safe(function () { ref.name(); return true; }, false); }
function ext(base, more) { var o = {}, k; for (k in base) o[k] = base[k]; for (k in more) o[k] = more[k]; return o; }
function addrOf(s) { var m = /<([^>]+)>/.exec(s || ''); return trim(m ? m[1] : String(s || '')).toLowerCase(); }
function toList(v) { // "a, b; c" → [a, b, c]; separators inside quotes or <…> do not split
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(trim).filter(Boolean);
  var out = [], cur = '', quoted = false, angle = false, str = String(v);
  for (var i = 0; i < str.length; i++) {
    var ch = str[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    if (!quoted && !angle && /[,;\n]/.test(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(trim).filter(Boolean);
}
function page(s, offset, max) { // long text in pages: {text, total_chars, next_offset?}
  s = String(s || '');
  var out = { text: s.slice(offset, offset + max), total_chars: s.length };
  if (offset + max < s.length) { out.next_offset = offset + max; note('Text is clipped; call again with offset ' + out.next_offset + ' for more.'); }
  return out;
}
function editDistance(a, b) {
  a = lower(a); b = lower(b);
  var prev = [], cur, i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur = [i];
    for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function closest(word, options) { // options within typo distance, best first
  var w = lower(word);
  return options.map(function (o) {
    var l = lower(o), d = editDistance(w, l);
    if (w.length >= 3 && (l.indexOf(w) >= 0 || w.indexOf(l) >= 0)) d = Math.min(d, 1);
    return { o: o, d: d };
  }).filter(function (x) { return x.d <= Math.max(2, Math.floor(w.length / 3)); })
    .sort(function (x, y) { return x.d - y.d; }).map(function (x) { return x.o; });
}
function didYouMean(word, options) { var c = closest(word, options); return c.length ? ' Did you mean "' + c[0] + '"?' : ''; }
function pickName(want, names) { // exact, then case-insensitive
  return names.filter(function (n) { return n === want; })[0] || names.filter(function (n) { return lower(n) === lower(want); })[0] || null;
}

// ---------- argument normalisation ----------
// Arg spec: { type, required, default, desc, values (enum), valueAliases, aliases, min, max, endOfDay, props, fromString }
// types: string, integer, boolean, id (Mail message id), ids, list (strings), addresses, date, object, objects
var KEY_ALIASES = { // alias → canonical; used only when the action has the canonical key and not the alias
  message_id: 'id', msg_id: 'id', mail_id: 'id', email_id: 'id', messageid: 'id', note_id: 'id', event_id: 'uid', event_uid: 'uid',
  message_ids: 'ids', msg_ids: 'ids', messages: 'ids', id_list: 'ids',
  folder: 'mailbox', box: 'mailbox', mailbox_name: 'mailbox', folder_name: 'mailbox', mail_folder: 'mailbox',
  account_name: 'account', acct: 'account', mail_account: 'account',
  recipient: 'to', recipients: 'to', to_address: 'to', to_addresses: 'to', email: 'to', address: 'to', send_to: 'to',
  copy: 'cc', blind_copy: 'bcc',
  text: 'body', content: 'body', message: 'body', body_text: 'body', note_text: 'body', reply: 'body', comment: 'body',
  q: 'query', search: 'query', keyword: 'query', keywords: 'query', term: 'query', search_query: 'query', search_text: 'query',
  max: 'limit', count: 'limit', n: 'limit', max_results: 'limit', top: 'limit', page_size: 'limit', number: 'limit',
  since: 'from_date', after: 'from_date', date_from: 'from_date', start_date: 'from_date',
  until: 'to_date', before: 'to_date', date_to: 'to_date', end_date: 'to_date',
  last_days: 'days', lookback: 'days', look_back: 'days', period: 'days', days_back: 'days',
  calendar_name: 'calendar', cal: 'calendar',
  path: 'dir', directory: 'dir', save_to: 'dir', destination_folder: 'dir', folder_path: 'dir',
  files: 'names', filenames: 'names', file_names: 'names', attachment_names: 'names',
  is_read: 'read', seen: 'read', mark_read: 'read', as_read: 'read',
  is_flagged: 'flagged', flag: 'flagged',
  as_draft: 'draft', preview: 'draft',
  all: 'reply_all', replyall: 'reply_all', to_all: 'reply_all',
  destination: 'to_mailbox', target: 'to_mailbox', target_mailbox: 'to_mailbox', to_folder: 'to_mailbox', target_folder: 'to_mailbox', dest: 'to_mailbox',
  target_account: 'to_account', destination_account: 'to_account',
  name: 'title', summary: 'title', subject: 'title', heading: 'title',
  title: 'subject', topic: 'subject',
  sender: 'from', from_address: 'from', from_email: 'from',
  location_name: 'location', place: 'location', where: 'location', address_line: 'location',
  description: 'notes', details: 'notes',
  html_body: 'html', is_html: 'html',
  include_body: 'bodies', with_bodies: 'bodies',
  show_deleted: 'include_deleted',
  test: 'dry_run', simulate: 'dry_run', dryrun: 'dry_run',
  everywhere: 'all_mailboxes', all_folders: 'all_mailboxes', search_all: 'all_mailboxes',
  attachments: 'has_attachments', with_attachments: 'has_attachments',
  unread_only: 'unread', only_unread: 'unread', unseen: 'unread',
  max_length: 'max_chars', length: 'max_chars',
  series: 'whole_series', all_occurrences: 'whole_series',
  allday: 'all_day', full_day: 'all_day'
};
function snake(k) { return String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s\-.]+/g, '_').toLowerCase(); }

var TRUE_WORDS = /^(true|yes|y|1|on|да)$/i, FALSE_WORDS = /^(false|no|n|0|off|нет|none)$/i;
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds()); }
var ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// ISO dates plus the words small models like to send. Returns a Date (with .dateOnly when no time was
// given) or null. strict (writes): only ISO 8601 and the words below, never the engine's loose parsing.
function parseWhen(v, endOfDay, strict) {
  if (v instanceof Date) return v;
  var s = lower(trim(v)), now = new Date(), m, day = null;
  if (s === 'now') return now;
  if (s === 'today') day = startOfDay(now);
  else if (s === 'tomorrow') day = startOfDay(addDays(now, 1));
  else if (s === 'yesterday') day = startOfDay(addDays(now, -1));
  else if ((m = /^([+-]\d+)\s*(d|days?)$/.exec(s))) day = startOfDay(addDays(now, parseInt(m[1], 10)));
  else if ((m = /^in\s+(\d+)\s*(d|days?|w|weeks?)$/.exec(s))) day = startOfDay(addDays(now, parseInt(m[1], 10) * (/^w/.test(m[2]) ? 7 : 1)));
  else if ((m = /^(\d+)\s*(d|days?|w|weeks?)\s+ago$/.exec(s))) day = startOfDay(addDays(now, -parseInt(m[1], 10) * (/^w/.test(m[2]) ? 7 : 1)));
  else if ((m = ISO_DATE.exec(trim(v)))) {
    var y = +m[1], mo = +m[2] - 1, d = +m[3], probe = new Date(y, mo, d);
    if (probe.getFullYear() !== y || probe.getMonth() !== mo || probe.getDate() !== d) return null; // 2026-02-30 is not a date
    if (m[4] == null) day = probe; // date only = that local day, not UTC midnight
    else {
      if (+m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59) return null;
      var t = new Date(trim(v).replace(' ', 'T'));
      if (isNaN(t.getTime())) return null;
      if (m[7] == null) t.localTime = true; // no offset: JavaScript reads it as this Mac's local time
      return t;
    }
  } else if (strict) return null;
  if (day) {
    var out = endOfDay ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59) : day;
    out.dateOnly = true;
    return out;
  }
  var loose = new Date(v);
  return isNaN(loose.getTime()) ? null : loose;
}

function coerce(v, spec, key, strict) {
  var t = spec.type;
  function bad(what) { fail('Argument "' + key + '" must be ' + what + ', got ' + JSON.stringify(v) + '.', spec.desc ? key + ': ' + spec.desc : ''); }
  if (Array.isArray(v) && v.length === 1 && ['string', 'integer', 'id', 'boolean', 'date', 'object'].indexOf(t) >= 0) v = v[0];
  switch (t) {
    case 'string': {
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      if (typeof v !== 'string') bad('text');
      var s = trim(v);
      if (!spec.values) return s;
      var hit = pickName(s, spec.values) || (spec.valueAliases || {})[lower(s)] || (spec.valueAliases || {})[snake(s)];
      if (!hit && !strict) { var c = closest(s, spec.values); if (c.length) { hit = c[0]; note('Read ' + key + ' "' + s + '" as "' + hit + '".'); } }
      if (!hit) fail('Argument "' + key + '" must be one of: ' + spec.values.join(', ') + '. Got "' + s + '".');
      return hit;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 1 || v === 0) return v === 1;
      if (typeof v === 'string' && TRUE_WORDS.test(trim(v))) return true;
      if (typeof v === 'string' && FALSE_WORDS.test(trim(v))) return false;
      return bad('true or false');
    case 'integer':
    case 'id': {
      var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*#?-?\d+\s*$/.test(v) ? parseInt(String(v).replace('#', ''), 10) : NaN);
      if (!isFinite(n) || Math.floor(n) !== n) bad(t === 'id' ? 'a message id (a whole number from list_messages or search_messages)' : 'a whole number');
      var min = spec.min != null ? spec.min : (t === 'id' ? 1 : 0), tunable = spec['default'] !== undefined; // sizes and counts are adjusted, ids and indexes never
      if (n < min) { if (!tunable) bad('at least ' + min); note(key + ' raised to ' + min + '.'); n = min; }
      if (spec.max && n > spec.max) { if (!tunable) bad('at most ' + spec.max); note(key + ' capped at ' + spec.max + '.'); n = spec.max; }
      return n;
    }
    case 'ids': {
      var items = Array.isArray(v) ? v : (typeof v === 'string' ? toList(v) : [v]);
      if (!items.length) bad('a non-empty list of message ids');
      return items.map(function (x, i) { return coerce(x, { type: 'id' }, key + '[' + i + ']', strict); });
    }
    case 'list': {
      var names = (Array.isArray(v) ? v.map(String) : toList(v)).map(trim).filter(Boolean);
      if (!names.length) bad('a non-empty list (leave it out instead)'); // an empty selector must not mean "all"
      return names;
    }
    case 'addresses': {
      var list = Array.isArray(v) ? v.map(String).map(trim).filter(Boolean) : toList(v);
      if (!list.length) bad('at least one email address');
      var wrong = list.filter(function (x) { return !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addrOf(x)); });
      if (wrong.length) fail('Not an email address: ' + wrong.join(', ') + ' (argument "' + key + '").', 'Give addresses like "anna@example.com" or "Anna <anna@example.com>", separated by commas.');
      return list;
    }
    case 'date': {
      var d = typeof v === 'string' || v instanceof Date ? parseWhen(v, spec.endOfDay, strict) : null;
      if (!d) bad('a real date: 2026-10-27, 2026-10-27T13:00:00-06:00, today, tomorrow, yesterday or "3 days ago"');
      return d;
    }
    case 'object':
    case 'objects':
      if (typeof v === 'string') {
        var parsed = safe(function () { return JSON.parse(v); }, undefined);
        if (parsed === undefined) { if (spec.fromString) return normaliseArgs(spec.fromString(v), spec.props, key, strict); bad(t === 'object' ? 'an object' : 'a list of objects'); }
        v = parsed;
      }
      if (t === 'object') return normaliseArgs(v, spec.props, key, strict);
      var objs = Array.isArray(v) ? v : [v];
      if (!objs.length) bad('a non-empty list');
      return objs.map(function (x, i) { return normaliseArgs(x, spec.props, key + '[' + i + ']', strict); });
  }
  return v;
}

// raw args → canonical args for one action. strict (write actions): unknown keys are errors, not ignored.
function normaliseArgs(raw, specs, path, strict) {
  if (raw == null) raw = {};
  if (typeof raw === 'string') raw = safe(function () { return JSON.parse(raw); }, raw);
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(path + ' must be an object like {"key": "value"}.');
  var out = {}, src = {}, unknown = [];
  Object.keys(raw).forEach(function (k) {
    var v = raw[k];
    if (v === null || v === undefined || v === '') return;
    var key = specs[k] ? k : snake(k);
    if (!specs[key]) {
      var alias = Object.keys(specs).filter(function (c) { return (specs[c].aliases || []).indexOf(key) >= 0; })[0] || KEY_ALIASES[key];
      if (alias && specs[alias]) { note('Read "' + k + '" as "' + alias + '".'); key = alias; }
    }
    if (!specs[key]) { unknown.push(k); return; }
    var val = coerce(v, specs[key], key, strict);
    if (src[key] !== undefined && stableJSON(out[key]) !== stableJSON(val)) fail('"' + src[key] + '" and "' + k + '" both set ' + key + ', to different values. Give it once.');
    out[key] = val; src[key] = k;
  });
  if (unknown.length) {
    var allowed = Object.keys(specs);
    var msg = 'Unknown argument' + (unknown.length > 1 ? 's ' : ' ') + unknown.map(function (k) { return '"' + k + '"' + didYouMean(snake(k), allowed); }).join(', ');
    if (strict) fail(msg + '.', 'Allowed here: ' + (allowed.join(', ') || 'none') + '.');
    note(msg + ' — ignored. Allowed here: ' + (allowed.join(', ') || 'none') + '.');
  }
  var missing = Object.keys(specs).filter(function (k) { return specs[k].required && out[k] === undefined; })
    .map(function (k) { return path === 'args' ? k : path + '.' + k; });
  if (missing.length) fail('Missing required argument' + (missing.length > 1 ? 's: ' : ': ') + missing.join(', ') + '.',
    missing.map(function (k) { var spec = specs[k.split('.').pop()]; return k + ' — ' + (spec.desc || spec.type); }).join('; '));
  Object.keys(specs).forEach(function (k) { if (out[k] === undefined && specs[k]['default'] !== undefined) out[k] = specs[k]['default']; });
  return out;
}
function stableJSON(v) {
  if (v instanceof Date) return JSON.stringify(v.toISOString() + (v.dateOnly ? '/day' : ''));
  if (Array.isArray(v)) return '[' + v.map(stableJSON).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stableJSON(v[k]); }).join(',') + '}';
  return JSON.stringify(v);
}

// ======================================================================
// Mail
// ======================================================================
var Mail = null;
function mail() { if (!Mail) { Mail = Application('Mail'); Mail.includeStandardAdditions = false; } return Mail; }

function accountNames() { return safe(function () { return mail().accounts.name(); }, []); }
function getAccount(name) {
  var names = accountNames(), exact = pickName(name, names);
  if (exact) return mail().accounts.byName(exact);
  var byAddress = mail().accounts().filter(function (a) { return safe(function () { return a.emailAddresses().some(function (e) { return lower(e) === addrOf(name); }); }, false); })[0];
  if (byAddress) { note('Account "' + name + '" is "' + byAddress.name() + '".'); return byAddress; }
  fail('No Mail account "' + name + '".' + didYouMean(name, names), 'Accounts: ' + names.join(', ') + '.');
}
function myAddresses() {
  var out = {};
  mail().accounts().forEach(function (a) { safe(function () { a.emailAddresses().forEach(function (e) { out[lower(e)] = true; }); }); });
  return out;
}

// A box is a resolved mailbox: { ref, account (null for the unified inbox), path, role, unified? }.
// Roles come from Mail's own special mailboxes; folder names in several languages are only a fallback.
var ROLE_PROPS = { inbox: 'inbox', sent: 'sentMailbox', trash: 'trashMailbox', junk: 'junkMailbox', drafts: 'draftsMailbox', outbox: 'outbox' };
var ROLE_NAMES = {
  inbox: /^(inbox|входящие|posteingang|boîte de réception|bandeja de entrada|posta in arrivo)$/i,
  sent: /^(sent|sent items|sent messages|sent mail|отправленные|gesendet|gesendete elemente|envoyés|éléments envoyés|enviados|elementos enviados|inviati|posta inviata|verzonden|verzonden items|wysłane|odeslané|skickat|skickade|sendt|lähetetyt|送信済み|已发送)$/i,
  trash: /^(trash|bin|deleted|deleted items|deleted messages|корзина|удаленные|удалённые|papierkorb|gelöschte elemente|corbeille|éléments supprimés|papelera|elementos eliminados|cestino|prullenbak|verwijderde items|kosz|koš|papperskorgen|papirkurv|roskakori|ゴミ箱|已删除)$/i,
  junk: /^(junk|junk mail|junk e-mail|spam|спам|нежелательные|нежелательная почта|werbung|courrier indésirable|indésirables|correo no deseado|posta indesiderata|ongewenste e-mail|迷惑メール|垃圾邮件)$/i,
  drafts: /^(drafts|черновики|entwürfe|brouillons|borradores|bozze|concepten|下書き|草稿)$/i,
  outbox: /^(outbox|исходящие|postausgang|boîte d'envoi|bandeja de salida|posta in uscita)$/i
};
var ROLE_WORDS = { inbox: 'inbox', sent: 'sent', trash: 'trash', deleted: 'trash', bin: 'trash', junk: 'junk', spam: 'junk', drafts: 'drafts', draft: 'drafts', outbox: 'outbox' };
var NOT_MAIL = ['trash', 'junk', 'drafts', 'outbox']; // skipped by searches and triage

function accountOfBox(mb) { return safe(function () { return mb.account().name(); }, null); }
function roleIndex() { // "account\0name" → role, from Mail's configuration
  var out = Object.create(null);
  Object.keys(ROLE_PROPS).forEach(function (role) {
    safe(function () { return mail()[ROLE_PROPS[role]].mailboxes(); }, []).forEach(function (mb) {
      safe(function () { out[accountOfBox(mb) + '\u0000' + mb.name()] = role; });
    });
  });
  return out;
}
function roleOfName(index, account, name) {
  var r = index[account + '\u0000' + name];
  if (r) return r;
  for (var k in ROLE_NAMES) if (ROLE_NAMES[k].test(name)) return k;
  return 'folder';
}
function allBoxes(account, everyAccount) { // every mailbox of one account (default: the default account, or all), with paths and roles
  account = account || (everyAccount ? null : DEFAULT_ACCOUNT) || null;
  var index = roleIndex(), out = [];
  function walk(list, accName, prefix) {
    list.forEach(function (mb) {
      var name = safe(function () { return mb.name(); }, null);
      if (name == null) return;
      var path = prefix ? prefix + '/' + name : name;
      out.push({ ref: mb, account: accName, path: path, role: roleOfName(index, accName, name) });
      var kids = safe(function () { return mb.mailboxes(); }, []);
      if (kids.length) walk(kids, accName, path);
    });
  }
  (account ? [getAccount(account)] : mail().accounts()).forEach(function (acc) { walk(safe(function () { return acc.mailboxes(); }, []), acc.name(), ''); });
  return out;
}
function roleBox(role, account) { // the account's own special mailbox, e.g. its Sent or Trash
  var hit = safe(function () { return mail()[ROLE_PROPS[role]].mailboxes(); }, []).filter(function (mb) { return accountOfBox(mb) === account; })[0];
  if (hit) return { ref: hit, account: account, path: hit.name(), role: role };
  return allBoxes(account).filter(function (b) { return b.role === role; })[0] || null;
}
function boxLabel(b) { return b.account ? b.account + ' / ' + b.path : b.path; }
function unifiedInbox() { return { ref: mail().inbox, account: null, path: 'INBOX', role: 'inbox', unified: true }; }

function getMailbox(account, mailbox) {
  account = account || DEFAULT_ACCOUNT || '';
  var want = trim(mailbox || 'INBOX'), role = ROLE_WORDS[lower(want)];
  if (!account) {
    if (role === 'inbox') return unifiedInbox();
    // no account given: use the folder if exactly one account has it
    var boxes = allBoxes(null), w = lower(want);
    var hits = role ? boxes.filter(function (b) { return b.role === role; })
      : boxes.filter(function (b) { return lower(b.path) === w || lower(b.path.split('/').pop()) === w; });
    if (hits.length === 1) { note('Folder "' + want + '" is ' + boxLabel(hits[0]) + '.'); return hits[0]; }
    fail(hits.length ? 'Folder "' + want + '" exists in several accounts: ' + hits.map(boxLabel).join('; ') + '.' : 'No folder "' + want + '" in any account.' + didYouMean(want, boxes.map(function (b) { return b.path; })),
      'Give "account" too. Accounts: ' + accountNames().join(', ') + '.');
  }
  var acc = getAccount(account), accName = acc.name();
  if (role) { var rb = roleBox(role, accName); if (rb) return rb; }
  var direct = acc.mailboxes.byName(want);
  if (exists(direct)) return { ref: direct, account: accName, path: want, role: roleOfName(roleIndex(), accName, want) };
  var all = allBoxes(accName), lw = lower(want);
  var found = all.filter(function (b) { return lower(b.path) === lw; });
  if (!found.length) found = all.filter(function (b) { return lower(b.path.split('/').pop()) === lw; });
  if (found.length === 1) { if (found[0].path !== want) note('Folder "' + want + '" is "' + found[0].path + '".'); return found[0]; }
  if (found.length > 1) fail('Several folders match "' + want + '" in ' + accName + ': ' + found.map(function (b) { return b.path; }).join(', ') + '.', 'Give the full path, e.g. "' + found[0].path + '".');
  fail('No folder "' + want + '" in account "' + accName + '".' + didYouMean(want, all.map(function (b) { return b.path; })),
    'Folders: ' + all.map(function (b) { return b.path; }).slice(0, 40).join(', ') + '.');
}
function realBox(m, fallback) { // where a message actually lives
  return safe(function () {
    var mb = m.mailbox(), acc = mb.account().name(), name = mb.name();
    return { ref: mb, account: acc, path: name, role: roleOfName(roleIndex(), acc, name) };
  }, fallback);
}

// Message lookup. Mail message ids are unique across folders, so a wrong folder is recovered by searching.
function getMessage(a) {
  var box = null;
  try { box = getMailbox(a.account, a.mailbox); } catch (e) {
    if (!(e instanceof UserError)) throw e;
    if (a.account && !pickName(a.account, accountNames())) throw e; // a wrong account is not guessed around
    note(e.message + ' Looked for message ' + a.id + ' in every folder instead.');
  }
  if (box) { var m = box.ref.messages.byId(a.id); if (messageExists(m)) return { ref: m, box: box.unified ? realBox(m, box) : box }; }
  var candidates = allBoxes(box && box.account, !box || !box.account);
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i].ref.messages.byId(a.id);
    if (messageExists(c)) { note('Message ' + a.id + ' is in ' + boxLabel(candidates[i]) + (box ? ', not ' + boxLabel(box) : '') + '.'); return { ref: c, box: candidates[i] }; }
  }
  fail('No message with id ' + a.id + ' in ' + (box && box.account ? 'account ' + box.account : 'any account') + '.', 'Ids come from list_messages or search_messages; copy id, account and mailbox from the same row.');
}
function messageExists(m) { return safe(function () { m.subject(); return true; }, false); }

// Rows: bulk-read message fields (one Apple Event per field, not per message).
function rowsOf(spec, box, withRecipients) {
  var ids = safe(function () { return spec.id(); }, []);
  if (!ids.length) return [];
  function bulk(f) { return safe(function () { return spec[f](); }, []); }
  var dates = bulk('dateReceived'), subs = bulk('subject'), senders = bulk('sender'), read = bulk('readStatus');
  var replied = bulk('wasRepliedTo'), forwarded = bulk('wasForwarded'), flagged = bulk('flaggedStatus'), mids = bulk('messageId');
  var rcpt = withRecipients ? recipientsOf(spec) : [];
  return ids.map(function (id, i) {
    return { i: i, spec: spec, box: box, id: id, date: dates[i], subject: subs[i], from: senders[i], read: read[i],
      replied: !!replied[i], forwarded: !!forwarded[i], flagged: !!flagged[i], messageId: mids[i] || null, rcpt: rcpt[i] || [] };
  });
}
function recipientsOf(spec) { // per message: lower-case to + cc addresses
  var to = safe(function () { return spec.toRecipients.address(); }, []), cc = safe(function () { return spec.ccRecipients.address(); }, []), out = [];
  for (var i = 0; i < Math.max(to.length, cc.length); i++) out.push([].concat(to[i] || [], cc[i] || []).map(lower));
  return out;
}
function rowOut(r) {
  var box = r.box && !r.box.unified ? r.box : realBox(r.spec[r.i], { account: null, path: null });
  return { id: r.id, account: box.account, mailbox: box.path, date: iso(r.date), from: r.from, subject: r.subject, read: r.read,
    replied: r.replied, forwarded: r.forwarded, flagged: r.flagged };
}
function newestFirst(a, b) { return (b.date || 0) - (a.date || 0); }
function dedupe(rows) { // one message can sit in several folders (Gmail "All Mail")
  var seen = Object.create(null);
  return rows.filter(function (r) { var k = r.messageId || (r.id + '|' + (r.box ? boxLabel(r.box) : '')); if (seen[k]) return false; seen[k] = 1; return true; });
}
function attachmentsOf(m) {
  return safe(function () {
    return m.mailAttachments().map(function (x) {
      return { name: x.name(), size: safe(function () { return x.fileSize(); }, null), mime: safe(function () { return x.mimeType(); }, null),
        downloaded: safe(function () { return x.downloaded(); }, null) };
    });
  }, []);
}
function addRecipients(msg, field, ctor, list) {
  toList(list).forEach(function (addr) {
    var m = /^(.*)<(.+)>\s*$/.exec(addr);
    msg[field].push(ctor(m ? { name: trim(m[1]).replace(/^"|"$/g, ''), address: trim(m[2]) } : { address: trim(addr) }));
  });
}
function recips(list) { return (list || []).map(function (r) { var n = r.name(), a = r.address(); return n ? n + ' <' + a + '>' : a; }); }
function normSubject(s) {
  return lower(String(s || '').replace(/^\s*((re|fw|fwd|aw|wg|sv|tr|rv|ответ|отв|пересл|ha)\s*(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim());
}
function daysAgo(n) { return new Date(Date.now() - n * 864e5); }
// Messages I sent since cutoff: f(box, id, subject, date, recipients[]) for each.
function eachSent(account, cutoff, f) {
  var boxes = allBoxes(account).filter(function (b) { return b.role === 'sent'; });
  if (!boxes.length) note('No Sent folder found' + (account ? ' in ' + account : '') + ', so your own replies could not be checked.');
  boxes.forEach(function (b) {
    checkCancelled();
    var spec = b.ref.messages.whose({ dateSent: { _greaterThan: cutoff } }), ids = safe(function () { return spec.id(); }, []);
    if (!ids.length) return;
    var subs = spec.subject(), dates = spec.dateSent(), rcpt = recipientsOf(spec);
    ids.forEach(function (id, i) { f(b, id, subs[i], dates[i], rcpt[i] || []); });
  });
}
function ensureSent(ok, what) { if (ok === false) fail('Mail did not send the ' + what + ' (it reported a failure).', 'Check the account in Mail, then try once more.'); }
function messageIds(a) {
  var ids = (a.ids || []).concat(a.id != null ? [a.id] : []);
  if (!ids.length) fail('Give "ids" (a list of message ids) or "id".', 'Ids come from list_messages or search_messages.');
  return ids.filter(function (x, i) { return ids.indexOf(x) === i; });
}
// f(found) per id → nothing (done), or a string (skipped: why). Lookup and Mail errors are reported per id,
// with their real text; a cancellation stops the loop before the next message.
function eachMessage(a, f, dryRun) {
  var ok = [], failed = [];
  messageIds(a).forEach(function (id) {
    if (!dryRun) checkCancelled();
    var found, why;
    try { found = getMessage({ id: id, account: a.account, mailbox: a.mailbox }); } catch (e) {
      if (e instanceof Cancelled) throw e;
      failed.push({ id: id, error: errorText(e) }); return;
    }
    try { why = f(found); } catch (e) {
      if (e instanceof Cancelled) throw e;
      why = errorText(e);
    }
    if (why) failed.push({ id: id, error: why }); else ok.push(id);
  });
  if (!ok.length && failed.length) fail((dryRun ? 'None of these would ' + dryRun + ': ' : 'Nothing was changed: ') + failed.map(function (x) { return x.id + ' (' + x.error + ')'; }).join(', ') + '.',
    'Ids come from list_messages or search_messages.');
  return { ok: ok, failed: failed };
}
function preview(a, verb, target) { // dry run: target(found) → {label} or {refused: why}
  var plan = [];
  var r = eachMessage(a, function (found) { var to = target(found); if (to.refused) return to.refused; plan.push(ext(summary(found), { to: to.label })); }, verb);
  return { dry_run: true, would: verb, messages: plan, refused: r.failed };
}
function summary(found) {
  var m = found.ref;
  return { id: m.id(), mailbox: boxLabel(found.box), date: iso(m.dateReceived()), from: m.sender(), subject: m.subject() };
}
// AppleScript string literal (create_rule builds an AppleScript)
function q(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t') + '"'; }
// Rule actions create_rule cannot rebuild (so a copy of the rule would be incomplete).
function ruleExtras(r) {
  var out = [];
  [['forward', function () { return r.forwardMessage(); }], ['redirect', function () { return r.redirectMessage(); }],
    ['reply', function () { return r.replyText(); }], ['copy to a folder', function () { return r.shouldCopyMessage(); }],
    ['play a sound', function () { return r.playSound(); }], ['run a script', function () { return r.runScript(); }],
    ['colour', function () { return r.highlightTextUsingColor() || r.colorMessage() !== 'none'; }]].forEach(function (p) {
    var v = safe(p[1], null);
    if (v && v !== 'none' && !(v && typeof v === 'object' && !Object.keys(v).length)) out.push(p[0]);
  });
  return out;
}
// AppleScript reference for a resolved mailbox, nested ones as "mailbox "B" of mailbox "A" of account …"
function mailboxRef(box) {
  return box.path.split('/').reverse().map(function (p) { return 'mailbox ' + q(p); }).join(' of ') + ' of account ' + q(box.account);
}
// A rule that deletes runs on every account's new mail; it is only allowed where every account keeps deleted mail in its Trash.
function assertRecoverableRuleDelete() {
  var unsafe = mail().accounts().filter(function (acc) {
    var n = acc.name();
    return !safe(function () { return acc.moveDeletedMessagesToTrash(); }, false) || !roleBox('trash', n);
  }).map(function (acc) { return acc.name(); });
  if (unsafe.length) fail('A deleting rule would remove mail for good in: ' + unsafe.join(', ') + ' (no Trash, or deleted mail is not kept there).',
    'Use a rule that moves mail to a folder instead (move_to).');
}
function getRule(name) {
  var names = safe(function () { return mail().rules.name(); }, []), exact = pickName(name, names);
  if (!exact) fail('No rule named "' + name + '".' + didYouMean(name, names), 'Rules: ' + (names.join(', ') || 'none') + '.');
  return mail().rules.byName(exact);
}
function uniquePath(dir, name) {
  var clean = String(name || 'attachment').replace(/[\/:]/g, '_').replace(/^\.+/, '_'), p = dir + '/' + clean, n = 1;
  var dot = clean.lastIndexOf('.'), base = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
  while ($.NSFileManager.defaultManager.fileExistsAtPath(p)) p = dir + '/' + base + ' (' + (n++) + ')' + ext;
  return p;
}

// Automated senders that never wait for an answer. Role addresses like hello@ or support@ are often people, so they stay.
var BOT_SENDER = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|newsletters?|automated|auto-?confirm)([._+-]|@)/i;

var MAIL = {
  list_accounts: function () {
    return mail().accounts().map(function (a) { return { name: a.name(), emails: safe(function () { return a.emailAddresses(); }, []), enabled: safe(function () { return a.enabled(); }, null) }; });
  },
  list_mailboxes: function (a) {
    return allBoxes(getAccount(a.account).name()).map(function (b) { return { mailbox: b.path, role: b.role, unread: safe(function () { return b.ref.unreadCount(); }, null) }; });
  },
  list_messages: function (a) {
    var box = getMailbox(a.account, a.mailbox);
    return rowsOf(a.unread ? box.ref.messages.whose({ readStatus: false }) : box.ref.messages, box).sort(newestFirst).slice(0, a.limit).map(rowOut);
  },
  search_messages: function (a) {
    var conds = [];
    if (a.query) {
      var t = [];
      if (/subject|any/.test(a['in'])) t.push({ subject: { _contains: a.query } });
      if (/sender|any/.test(a['in'])) t.push({ sender: { _contains: a.query } });
      if (/body|any/.test(a['in'])) t.push({ content: { _contains: a.query } });
      conds.push(t.length > 1 ? { _or: t } : t[0]);
    }
    if (a.from) conds.push({ sender: { _contains: a.from } });
    if (a.subject) conds.push({ subject: { _contains: a.subject } });
    if (a.from_date) conds.push({ dateReceived: { _greaterThan: a.from_date } });
    if (a.to_date) conds.push({ dateReceived: { _lessThan: a.to_date } });
    if (a.unread) conds.push({ readStatus: false });
    if (a.flagged) conds.push({ flaggedStatus: true });
    if (!conds.length && !a.has_attachments) fail('Nothing to search for.', 'Give query, or a filter: from, subject, from_date, to_date, unread, flagged, has_attachments.');
    var boxes = a.all_mailboxes ? allBoxes(a.account).filter(function (b) { return NOT_MAIL.indexOf(b.role) < 0; }) : [getMailbox(a.account, a.mailbox)];
    var rows = [];
    boxes.forEach(function (b) {
      checkCancelled();
      rows = rows.concat(rowsOf(conds.length ? b.ref.messages.whose(conds.length > 1 ? { _and: conds } : conds[0]) : b.ref.messages, b));
    });
    rows = dedupe(rows).sort(newestFirst);
    var out = [], checked = 0, MAX_CHECKS = 300;
    for (var k = 0; k < rows.length && out.length < a.limit; k++) {
      if (a.has_attachments) {
        if (++checked > MAX_CHECKS) { note('Stopped after checking ' + MAX_CHECKS + ' messages for attachments; narrow the search (dates, from, mailbox).'); break; }
        var r = rows[k];
        if (!safe(function () { return r.spec[r.i].mailAttachments().length; }, 0)) continue;
      }
      out.push(rowOut(rows[k]));
    }
    if (!out.length && !a.all_mailboxes) note('Searched only ' + boxes.map(boxLabel).join(', ') + '. all_mailboxes:true searches every folder.');
    return out;
  },
  // Sent emails with no later message from any of the people they went to.
  awaiting_reply: function (a) {
    var cutoff = daysAgo(a.days), me = myAddresses(), mine = Object.create(null), bySubject = Object.create(null);
    eachSent(a.account, cutoff, function (b, id, subject, date, rcpt) {
      var subj = normSubject(subject), people = rcpt.filter(function (x) { return !me[x]; });
      if (!subj || !people.length) return;
      var key = subj + '\u0000' + people.slice().sort().join(',');
      if (!mine[key] || date > mine[key].date) mine[key] = { id: id, box: b, subject: subject, date: date, people: people };
      (bySubject[subj] = bySubject[subj] || {})[key] = 1;
    });
    allBoxes(a.account).forEach(function (b) {
      if (b.role === 'sent' || NOT_MAIL.indexOf(b.role) >= 0) return;
      checkCancelled();
      var spec = b.ref.messages.whose({ dateReceived: { _greaterThan: cutoff } }), ids = safe(function () { return spec.id(); }, []);
      if (!ids.length) return;
      var subs = spec.subject(), dates = spec.dateReceived(), from = spec.sender();
      ids.forEach(function (_, i) {
        var who = addrOf(from[i]), keys = bySubject[normSubject(subs[i])];
        if (me[who] || !keys) return;
        Object.keys(keys).forEach(function (key) { // answered only by someone it was sent to
          var s = mine[key];
          if (s.people.indexOf(who) >= 0 && dates[i] > s.date) s.answered = true;
        });
      });
    });
    return Object.keys(mine).map(function (k) { return mine[k]; }).filter(function (s) { return !s.answered; })
      .map(function (s) { return { to: s.people.join(', '), subject: s.subject, sent: iso(s.date), days_waiting: Math.floor((Date.now() - s.date) / 864e5), id: s.id, account: s.box.account, mailbox: s.box.path }; })
      .sort(function (x, y) { return y.days_waiting - x.days_waiting; }).slice(0, a.limit);
  },
  // Inbox mail from people, not marked replied, and you have not written to that sender in that conversation since.
  needs_response: function (a) {
    var cutoff = daysAgo(a.days), me = myAddresses(), lastMine = Object.create(null);
    eachSent(a.account, cutoff, function (b, id, subject, date, rcpt) {
      var subj = normSubject(subject);
      if (subj) rcpt.forEach(function (who) { var k = subj + '\u0000' + who; if (!lastMine[k] || date > lastMine[k]) lastMine[k] = date; });
    });
    var inbox = getMailbox(a.account, 'INBOX'), latest = Object.create(null);
    rowsOf(inbox.ref.messages.whose({ dateReceived: { _greaterThan: cutoff } }), inbox).forEach(function (r) {
      var who = addrOf(r.from);
      if (!who || me[who] || BOT_SENDER.test(who)) return;
      var k = (normSubject(r.subject) || ('#' + r.id)) + '\u0000' + who;
      if (!latest[k] || r.date > latest[k].date) latest[k] = r;
    });
    return Object.keys(latest).filter(function (k) { var r = latest[k]; return !r.replied && !(lastMine[k] && lastMine[k] > r.date); })
      .map(function (k) { var o = rowOut(latest[k]); o.waiting_days = Math.floor((Date.now() - latest[k].date) / 864e5); return o; })
      .sort(function (x, y) { return y.waiting_days - x.waiting_days; }).slice(0, a.limit);
  },
  // Same subject AND the same people (sender, or recipients of your own messages) — subject alone merges strangers.
  get_thread: function (a) {
    var found = getMessage(a), m = found.ref, subj = normSubject(m.subject()), me = myAddresses();
    var people = [addrOf(m.sender())].concat(safe(function () { return m.toRecipients.address(); }, []), safe(function () { return m.ccRecipients.address(); }, []))
      .map(lower).filter(function (x) { return x && !me[x]; });
    if (!subj) return [MAIL.read_message({ id: a.id, account: found.box.account, mailbox: found.box.path, offset: 0, max_chars: a.max_chars })];
    var core = subj.slice(0, 60), rows = [];
    allBoxes(found.box.account).forEach(function (b) {
      if (b.role === 'trash' || b.role === 'junk') return;
      checkCancelled();
      rowsOf(b.ref.messages.whose({ subject: { _contains: core } }), b, true).forEach(function (r) {
        if (normSubject(r.subject) !== subj) return;
        var who = addrOf(r.from);
        if (me[who] ? r.rcpt.some(function (x) { return people.indexOf(x) >= 0; }) : people.indexOf(who) >= 0) rows.push(r);
      });
    });
    rows = dedupe(rows).sort(function (x, y) { return (x.date || 0) - (y.date || 0); });
    if (rows.length > a.limit) { note('Showing the last ' + a.limit + ' of ' + rows.length + ' messages.'); rows = rows.slice(-a.limit); }
    return rows.map(function (r) {
      var o = rowOut(r);
      if (a.bodies) o.body = safe(function () { return page(r.spec[r.i].content(), 0, a.max_chars).text; }, null);
      return o;
    });
  },
  list_attachments: function (a) { return attachmentsOf(getMessage(a).ref); },
  read_message: function (a) {
    var found = getMessage(a), m = found.ref, body = page(safe(function () { return m.content(); }, ''), a.offset, a.max_chars);
    return {
      id: a.id, account: found.box.account, mailbox: found.box.path, date: iso(m.dateReceived()),
      from: m.sender(), to: recips(m.toRecipients()), cc: recips(m.ccRecipients()), reply_to: safe(function () { return m.replyTo(); }, null),
      subject: m.subject(), read: m.readStatus(),
      replied: safe(function () { return m.wasRepliedTo(); }, null), forwarded: safe(function () { return m.wasForwarded(); }, null),
      flagged: safe(function () { return m.flaggedStatus(); }, null),
      attachments: attachmentsOf(m), body: body.text, body_chars: body.total_chars, next_offset: body.next_offset
    };
  },
  list_rules: function () {
    return mail().rules().map(function (r) {
      var mv = safe(function () { if (!r.shouldMoveMessage()) return null; var mb = r.moveMessage(); return mb.account().name() + ' / ' + mb.name(); }, null);
      var o = { name: r.name(), enabled: r.enabled(), match: r.allConditionsMustBeMet() ? 'all' : 'any',
        conditions: safe(function () { return r.ruleConditions(); }, []).map(function (c) { return { field: c.ruleType(), op: c.qualifier(), value: c.expression() }; }),
        move_to: mv, mark_read: r.markRead(), flag: safe(function () { return r.markFlagged(); }, null), 'delete': r.deleteMessage(), stop: r.stopEvaluatingRules() };
      var other = ruleExtras(r);
      if (other.length) o.other_actions = other;
      return o;
    });
  },

  send_email: function (a) {
    var M = mail();
    if (a.from && !myAddresses()[addrOf(a.from)]) {
      var acc = pickName(a.from, accountNames()), accAddr = acc && safe(function () { return M.accounts.byName(acc).emailAddresses()[0]; }, null);
      if (!accAddr) fail('"' + a.from + '" is not one of your sending addresses.', 'Use one of: ' + Object.keys(myAddresses()).join(', ') + ' — or leave "from" out.');
      note('Sending from ' + accAddr + ' (account ' + acc + ').');
      a.from = accAddr;
    }
    var msg = M.OutgoingMessage({ subject: a.subject, content: a.body, visible: a.draft });
    M.outgoingMessages.push(msg);
    addRecipients(msg, 'toRecipients', M.ToRecipient, a.to);
    addRecipients(msg, 'ccRecipients', M.CcRecipient, a.cc);
    addRecipients(msg, 'bccRecipients', M.BccRecipient, a.bcc);
    if (a.from) msg.sender = a.from;
    var info = { to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject };
    if (a.draft) { M.activate(); info.status = 'Draft opened in Mail. Nothing was sent: the user checks it and presses Send.'; return info; }
    checkCancelled();
    ensureSent(msg.send(), 'email');
    info.status = 'Sent.';
    return info;
  },
  // Mail fills in the recipients and the quote itself, so a reply opens as a draft unless draft:false.
  reply_message: function (a) {
    var M = mail(), m = getMessage(a).ref, orig = safe(function () { return m.content(); }, '') || '';
    var quoted = '\n\n' + m.sender() + ' wrote on ' + (iso(m.dateReceived()) || '') + ':\n' + orig.split('\n').map(function (l) { return '> ' + l; }).join('\n');
    var r = M.reply(m, { openingWindow: a.draft, replyToAll: a.reply_all });
    r.content = a.body + quoted;
    var info = { to: recips(r.toRecipients()), cc: recips(r.ccRecipients()), subject: r.subject() };
    if (a.draft) { M.activate(); info.status = 'Reply opened in Mail as a draft. Nothing was sent: the user checks it and presses Send.'; return info; }
    checkCancelled();
    ensureSent(r.send(), 'reply');
    info.status = 'Reply sent.';
    return info;
  },
  forward_message: function (a) {
    var M = mail(), m = getMessage(a).ref, attachments = attachmentsOf(m).length;
    var f = M.forward(m, { openingWindow: a.draft });
    addRecipients(f, 'toRecipients', M.ToRecipient, a.to);
    addRecipients(f, 'ccRecipients', M.CcRecipient, a.cc);
    addRecipients(f, 'bccRecipients', M.BccRecipient, a.bcc);
    if (a.body) {
      var orig = safe(function () { return f.content(); }, '') || ('---------- Forwarded message ----------\nFrom: ' + m.sender() + '\nDate: ' + (iso(m.dateReceived()) || '') +
        '\nSubject: ' + m.subject() + '\n\n' + safe(function () { return m.content(); }, ''));
      f.content = a.body + '\n\n' + orig;
    }
    var kept = safe(function () { return f.mailAttachments().length; }, attachments);
    var info = { to: recips(f.toRecipients()), cc: recips(f.ccRecipients()), subject: safe(function () { return f.subject(); }, null), attachments: kept };
    if (kept < attachments) {
      if (!a.draft) { safe(function () { f.close({ saving: 'no' }); }); fail('Adding the note dropped the attachments, so nothing was sent.', 'Forward without "body", or use draft:true and let the user add the note in Mail.'); }
      note('Mail dropped ' + (attachments - kept) + ' attachment(s) when the note was added; tell the user to check the draft.');
    }
    if (a.draft) { M.activate(); info.status = 'Forward opened in Mail as a draft. Nothing was sent: the user checks it and presses Send.'; return info; }
    checkCancelled();
    ensureSent(f.send(), 'forward');
    info.status = 'Forwarded.';
    return info;
  },
  set_read: function (a) {
    var r = eachMessage(a, function (found) { found.ref.readStatus = a.read; });
    return { marked: a.read ? 'read' : 'unread', updated: r.ok.length, failed: r.failed };
  },
  set_flag: function (a) {
    var COLORS = { red: 0, orange: 1, yellow: 2, green: 3, blue: 4, purple: 5, gray: 6 };
    var r = eachMessage(a, function (found) {
      var m = found.ref;
      if (!a.flagged) { m.flaggedStatus = false; safe(function () { m.flagIndex = -1; }); return; }
      m.flaggedStatus = true;
      if (a.color) { try { m.flagIndex = COLORS[a.color]; } catch (e) { note('Message ' + found.ref.id() + ' is flagged, but Mail did not take the color: ' + errorText(e)); } }
    });
    return { flagged: a.flagged, color: a.color, updated: r.ok.length, failed: r.failed };
  },
  move_messages: function (a) {
    var M = mail(), targets = {};
    function target(found) {
      var acc = a.to_account || found.box.account, dst = targets[acc] || (targets[acc] = getMailbox(acc, a.to_mailbox));
      return boxLabel(dst) === boxLabel(found.box) ? 'already in ' + boxLabel(dst) : dst;
    }
    if (a.dry_run) return preview(a, 'move', function (found) { var t = target(found); return typeof t === 'string' ? { refused: t } : { label: boxLabel(t) }; });
    var r = eachMessage(a, function (found) { var t = target(found); if (typeof t === 'string') return t; M.move(found.ref, { to: t.ref }); });
    return { moved: r.ok.length, to: Object.keys(targets).map(function (k) { return boxLabel(targets[k]); }), failed: r.failed };
  },
  // Moves into the account's own Trash folder (recoverable). Never deletes for good.
  delete_messages: function (a) {
    var M = mail(), trashes = {};
    function trashOf(found) { // a mailbox, or why not
      var acc = found.box.account;
      if (found.box.role === 'trash') return 'already in Trash; deleting there would be permanent';
      if (!(acc in trashes)) trashes[acc] = roleBox('trash', acc);
      return trashes[acc] || 'account ' + acc + ' has no Trash folder, so deleting would be permanent';
    }
    if (a.dry_run) return preview(a, 'go to Trash', function (found) { var t = trashOf(found); return typeof t === 'string' ? { refused: t } : { label: boxLabel(t) }; });
    var r = eachMessage(a, function (found) { var t = trashOf(found); if (typeof t === 'string') return t; M.move(found.ref, { to: t.ref }); });
    if (r.failed.length) note('Not deleted: ' + r.failed.map(function (x) { return x.id + ' (' + x.error + ')'; }).join(', ') + '. The user can delete those in Mail.');
    return { moved_to_trash: r.ok.length, failed: r.failed };
  },
  // Attachments only go inside the attachments folder from the extension settings (default ~/Downloads).
  save_attachments: function (a) {
    var M = mail(), m = getMessage(a).ref, dir = SAVE_DIR;
    if (a.dir) {
      dir = stdPath(/^[\/~]/.test(a.dir) ? a.dir : SAVE_DIR + '/' + a.dir);
      if (dir !== SAVE_DIR && dir.indexOf(SAVE_DIR + '/') !== 0) fail('Attachments can only be saved inside ' + SAVE_DIR + ' (the attachments folder in the extension settings).', 'Leave "dir" out, or give a subfolder name like "invoices".');
    }
    var all = m.mailAttachments(), names = all.map(function (x) { return x.name(); }), saved = [], failed = [];
    if (!all.length) fail('This message has no attachments.');
    var want = a.names || null;
    if (want && want.length > 1 && !want.some(function (w) { return names.indexOf(w) >= 0; }) && names.indexOf(want.join(', ')) >= 0) want = [want.join(', ')]; // one file name with a comma, split by mistake
    if (want) {
      var missing = want.filter(function (w) { return names.indexOf(w) < 0; });
      if (missing.length === want.length) fail('No attachments named ' + missing.join(', ') + '.', 'Attachments: ' + names.join(', ') + '.');
      if (missing.length) note('Not found: ' + missing.join(', ') + '.');
    }
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
    all.forEach(function (x, i) {
      if (want && want.indexOf(names[i]) < 0) return;
      checkCancelled();
      try { var p = uniquePath(dir, names[i]); M.save(x, { 'in': Path(p) }); saved.push(p); } catch (e) { if (e instanceof Cancelled) throw e; failed.push(names[i] + ': ' + errorText(e)); }
    });
    return { saved: saved, failed: failed };
  },
  // "Parent/Child" creates each missing level under its parent.
  create_mailbox: function (a) {
    var M = mail(), acc = getAccount(a.account), accName = acc.name(), parts = a.name.split('/').map(trim).filter(Boolean), parent = null, path = '', created = [];
    if (!parts.length) fail('"' + a.name + '" has no folder name in it.', 'Give a name like "Receipts", or "Parent/Child" for a subfolder.');
    if (parts.join('/') !== a.name) note('Folder path read as "' + parts.join('/') + '".');
    parts.forEach(function (part) {
      path = path ? path + '/' + part : part;
      var list = parent ? parent.mailboxes : acc.mailboxes, existing = list.byName(part);
      if (exists(existing)) { parent = existing; return; }
      list.push(M.Mailbox({ name: part }));
      var made = list.byName(part);
      if (!exists(made)) fail('Mail did not create "' + path + '" in ' + accName + '.', 'Some accounts (e.g. Exchange) do not allow folders at this level.');
      parent = made; created.push(path);
    });
    if (!created.length) fail('Folder "' + a.name + '" already exists in ' + accName + '.');
    return { created: created, account: accName };
  },
  create_rule: function (a) {
    // Built with AppleScript: Mail's JXA bridge cannot add rule conditions reliably.
    var FIELD = { from: 'from header', to: 'to header', cc: 'cc header', subject: 'subject header', any_recipient: 'any recipient', content: 'message content' };
    var OP = { contains: 'does contain value', not_contains: 'does not contain value', begins: 'begins with value', ends: 'ends with value', equals: 'equal to value' };
    if (safe(function () { mail().rules.byName(a.name).name(); return true; }, false)) fail('A rule named "' + a.name + '" already exists.', 'Pick another name, or delete_rule first.');
    var move = a.move_to ? getMailbox(a.move_to.account, a.move_to.mailbox) : null;
    if (a['delete']) assertRecoverableRuleDelete();
    if (!move && !a.mark_read && !a.flag && !a['delete']) note('The rule has no action (move_to, mark_read, flag, delete).');
    var props = ['name:' + q(a.name), 'enabled:false', 'all conditions must be met:' + (a.match === 'all')];
    if (move) props.push('should move message:true', 'move message:(' + mailboxRef(move) + ')');
    if (a.mark_read) props.push('mark read:true');
    if (a.flag) props.push('mark flagged:true');
    if (a['delete']) props.push('delete message:true');
    if (a.stop) props.push('stop evaluating rules:true');
    var lines = ['tell application "Mail"', '  set r to make new rule at end of rules with properties {' + props.join(', ') + '}', '  tell r',
      '    delete every rule condition']; // Mail may add a default condition to a new rule
    a.conditions.forEach(function (c) {
      lines.push('    make new rule condition at end of rule conditions with properties {rule type:' + FIELD[c.field] + ', qualifier:' + OP[c.op] + ', expression:' + q(c.value) + '}');
    });
    lines.push('  end tell', '  if (count of rule conditions of r) is not ' + a.conditions.length + ' then error "Mail did not keep the rule conditions"');
    if (a.enabled) lines.push('  set enabled of r to true');
    lines.push('end tell');
    var app = Application.currentApplication();
    app.includeStandardAdditions = true;
    checkCancelled();
    try { app.runScript(lines.join('\n'), { 'in': 'AppleScript' }); } catch (e) {
      try { var r = mail().rules.byName(a.name); r.name(); mail()['delete'](r); } catch (e2) {} // never leave a half-built rule behind
      fail('Mail could not create the rule: ' + errorText(e) + '. Nothing was left behind.');
    }
    return MAIL.list_rules().filter(function (x) { return x.name === a.name; })[0];
  },
  set_rule_enabled: function (a) {
    var r = getRule(a.name);
    if (a.enabled && safe(function () { return r.deleteMessage(); }, true)) assertRecoverableRuleDelete();
    r.enabled = a.enabled;
    return { rule: r.name(), enabled: a.enabled };
  },
  // Mail keeps no copy of a deleted rule, so the result carries the whole rule for create_rule — and a rule
  // that create_rule could not rebuild is not deleted at all.
  delete_rule: function (a) {
    var r = getRule(a.name), n = r.name(), extras = ruleExtras(r);
    if (extras.length) fail('Rule "' + n + '" also does: ' + extras.join(', ') + '. That could not be recreated after deleting, so it was not deleted.', 'Turn it off instead: set_rule_enabled with enabled:false.');
    var copy = MAIL.list_rules().filter(function (x) { return x.name === n; })[0];
    mail()['delete'](r);
    note('Rules cannot be restored in Mail. The deleted rule is in "copy"; tell the user, and recreate it with create_rule if asked.');
    return { deleted_rule: n, copy: copy };
  }
};

// ======================================================================
// Calendar
// ======================================================================
var Cal = null;
function cal() { if (!Cal) Cal = Application('Calendar'); return Cal; }

// The JXA bridge gives no usable calendar id, so calendars are told apart by their index in list_calendars.
function calendarList() {
  return cal().calendars().map(function (c, i) { return { ref: c, index: i, name: c.name(), writable: safe(function () { return c.writable(); }, true) }; });
}
function pickCalendar(a, list) { // null when neither calendar nor calendar_index is given
  if (a.calendar_index != null) {
    var c = list[a.calendar_index];
    if (!c) fail('No calendar with index ' + a.calendar_index + '.', 'Indexes come from list_calendars (0 to ' + (list.length - 1) + ').');
    if (a.calendar && lower(c.name) !== lower(a.calendar)) fail('calendar_index ' + a.calendar_index + ' is "' + c.name + '", not "' + a.calendar + '".');
    return c;
  }
  if (!a.calendar) return null;
  var names = list.map(function (x) { return x.name; }), name = pickName(a.calendar, names);
  if (!name) fail('No calendar named "' + a.calendar + '".' + didYouMean(a.calendar, names), 'Calendars: ' + names.join(', ') + '.');
  var m = list.filter(function (x) { return x.name === name; });
  if (m.length > 1) fail('Several calendars are named "' + name + '" (indexes ' + m.map(function (x) { return x.index; }).join(', ') + ').', 'Pass calendar_index from list_calendars.');
  return m[0];
}

// Expand an iCalendar RRULE (as Calendar reports it) into the occurrences overlapping [from, to).
// Supports FREQ, INTERVAL, COUNT, UNTIL, BYDAY (also with ordinals like 3MO, -1FR), BYMONTH, BYMONTHDAY.
// Returns null for rules with other parts; the series is then listed once, unexpanded.
var WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function tzOffset(d) { var m = -d.getTimezoneOffset(), s = m < 0 ? '-' : '+'; m = Math.abs(m); return s + ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + m % 60).slice(-2); }
function parseRule(rule) {
  var r = {};
  String(rule).split(';').forEach(function (kv) { var p = kv.split('='); if (p[0]) r[p[0].toUpperCase()] = p[1] || ''; });
  var known = { FREQ: 1, INTERVAL: 1, COUNT: 1, UNTIL: 1, BYDAY: 1, BYMONTH: 1, BYMONTHDAY: 1, WKST: 1 };
  for (var k in r) if (!known[k]) return null;
  if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].indexOf(r.FREQ) < 0) return null;
  var out = { freq: r.FREQ, interval: Math.max(1, parseInt(r.INTERVAL || '1', 10)), count: r.COUNT ? parseInt(r.COUNT, 10) : Infinity, until: Infinity };
  if (r.UNTIL) {
    var u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(r.UNTIL);
    if (!u) return null;
    out.until = u[4] == null ? new Date(+u[1], +u[2] - 1, +u[3], 23, 59, 59).getTime()
      : (u[7] ? Date.UTC(+u[1], +u[2] - 1, +u[3], +u[4], +u[5], +u[6]) : new Date(+u[1], +u[2] - 1, +u[3], +u[4], +u[5], +u[6]).getTime());
  }
  if (r.BYDAY) {
    out.byday = r.BYDAY.split(',').map(function (x) { var m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x); return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS[m[2]] } : null; });
    if (out.byday.some(function (x) { return !x; })) return null;
  }
  if (r.BYMONTH) out.bymonth = r.BYMONTH.split(',').map(function (x) { return parseInt(x, 10) - 1; });
  if (r.BYMONTHDAY) out.bymd = r.BYMONTHDAY.split(',').map(function (x) { return parseInt(x, 10); });
  if (out.bymd && out.byday) return null; // both at once (e.g. "Friday the 13th") is not expanded here
  if (r.WKST && r.WKST !== 'MO' && out.freq === 'WEEKLY' && out.interval > 1) return null; // week boundaries assume Monday
  if (out.freq === 'WEEKLY' && out.byday && out.byday.some(function (b) { return b.n; })) return null; // ordinals only make sense monthly/yearly
  return out;
}
function expandRecurrence(rule, start, end, excluded, from, to) {
  var r = parseRule(rule);
  if (!r) return null;
  var dur = end - start, h = start.getHours(), mi = start.getMinutes(), se = start.getSeconds(), skip = {};
  (excluded || []).forEach(function (d) { safe(function () { skip[Math.floor(new Date(d).getTime() / 60000)] = 1; }); });
  function at(y, m, d) { return new Date(y, m, d, h, mi, se); }
  function inMonth(m) { return !r.bymonth || r.bymonth.indexOf(m) >= 0; }
  function monthDays(y, m) { // candidate days of one month (MONTHLY, YEARLY)
    var n = new Date(y, m + 1, 0).getDate(), out = [];
    if (r.bymd) r.bymd.forEach(function (d) { var dd = d > 0 ? d : n + d + 1; if (dd >= 1 && dd <= n) out.push(dd); });
    else if (r.byday) r.byday.forEach(function (b) {
      var all = []; for (var d = 1; d <= n; d++) if (new Date(y, m, d).getDay() === b.wd) all.push(d);
      if (!b.n) out = out.concat(all); else { var pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (pick) out.push(pick); }
    });
    else if (start.getDate() <= n) out.push(start.getDate());
    return out.sort(function (x, y2) { return x - y2; });
  }
  function candidates(period) {
    var out = [];
    if (r.freq === 'DAILY') {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + period * r.interval);
      var dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (inMonth(d.getMonth()) && (!r.byday || r.byday.some(function (b) { return b.wd === d.getDay(); })) &&
          (!r.bymd || r.bymd.some(function (x) { return (x > 0 ? x : dim + x + 1) === d.getDate(); })))
        out.push(at(d.getFullYear(), d.getMonth(), d.getDate()));
    } else if (r.freq === 'WEEKLY') {
      var monday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - ((start.getDay() + 6) % 7) + period * 7 * r.interval);
      (r.byday ? r.byday.map(function (b) { return (b.wd + 6) % 7; }) : [(start.getDay() + 6) % 7]).sort(function (x, z) { return x - z; }).forEach(function (off) {
        var dd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + off);
        if (inMonth(dd.getMonth())) out.push(at(dd.getFullYear(), dd.getMonth(), dd.getDate()));
      });
    } else if (r.freq === 'MONTHLY') {
      var first = new Date(start.getFullYear(), start.getMonth() + period * r.interval, 1), y = first.getFullYear(), m = first.getMonth();
      if (inMonth(m)) monthDays(y, m).forEach(function (dd) { out.push(at(y, m, dd)); });
    } else {
      var yy = start.getFullYear() + period * r.interval;
      (r.bymonth || [start.getMonth()]).slice().sort(function (x, z) { return x - z; }).forEach(function (mm) { monthDays(yy, mm).forEach(function (dd) { out.push(at(yy, mm, dd)); }); });
    }
    return out;
  }
  var occ = [], seen = 0;
  for (var period = 0; period < 50000; period++) {
    var list = candidates(period);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c < start) continue;
      if (c.getTime() > r.until || seen >= r.count || c >= to) return occ;
      seen++;
      if (!skip[Math.floor(c.getTime() / 60000)] && c.getTime() + dur > from.getTime()) occ.push({ start: c, end: new Date(c.getTime() + dur) });
    }
  }
  return occ;
}
// Some calendars (subscribed ones especially) answer each Apple Event slowly, and a `whose` query is
// re-run for every property. So: three bulk reads per calendar (start, end, rule), cached while the
// event count stays the same, and the remaining fields only for the events that fall in the window.
// The cache is short-lived (a model asking twice in a row) and dropped by our own writes; edits made in Calendar
// meanwhile show up within a minute.
var EVENT_CACHE = {}, EVENT_CACHE_MS = 60e3;
function eventTimes(c, fresh) { // bulk start/end/rule/uid of one calendar, by index; null if Calendar would not say
  var key = c.index + '\u0000' + c.name, count = safe(function () { return c.ref.events.length; }, -1), hit = EVENT_CACHE[key];
  if (!fresh && hit && hit.count === count && Date.now() - hit.at < EVENT_CACHE_MS) return hit;
  try {
    hit = { count: count, at: Date.now(), start: c.ref.events.startDate(), end: c.ref.events.endDate(), rule: c.ref.events.recurrence(), uid: c.ref.events.uid() };
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    delete EVENT_CACHE[key];
    return null;
  }
  return (EVENT_CACHE[key] = hit);
}
// Occurrences in [from, to) of one calendar, repeating events expanded. Cached rows are read by index, so each
// detail read checks that the index still holds the same uid; if not, the calendar is read again, once.
function eventsIn(c, from, to, retried) {
  var t = eventTimes(c, retried), out = [], moved = false;
  if (!t) { note('Calendar "' + c.name + '" could not be read, so its events are missing here.'); return out; }
  for (var i = 0; i < t.start.length && !moved; i++) {
    var start = t.start[i], end = t.end[i], rule = t.rule[i] || '';
    if (!start || start >= to) continue;
    var occ;
    if (!rule) occ = end > from ? [{ start: start, end: end }] : [];
    else {
      occ = expandRecurrence(rule, start, end, [], from, to);
      if (occ && occ.length) { // only now is it worth reading the exceptions
        var ex = safe(function () { return c.ref.events[i].excludedDates(); }, []);
        if (ex && ex.length) occ = expandRecurrence(rule, start, end, ex, from, to);
      }
    }
    if (occ && !occ.length) continue;
    var ev = c.ref.events[i];
    if (safe(function () { return ev.uid(); }, null) !== t.uid[i]) { moved = true; break; }
    var base = { title: safe(function () { return ev.summary(); }, ''), uid: t.uid[i], location: safe(function () { return ev.location(); }, null) || null,
      all_day: !!safe(function () { return ev.alldayEvent(); }, false), recurring: !!rule, calendar: c.name, calendar_index: c.index };
    if (occ === null) { // a rule this server cannot expand: the series may well be in the window, so say so
      var until = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rule);
      if (until && new Date(+until[1], +until[2] - 1, +until[3], 23, 59, 59) < from) continue; // it ended before the window
      out.push(ext(base, { start: start, end: end, recurrence: rule, note: 'repeats by a rule this server cannot expand (series start shown); check Calendar for the dates in this range' }));
      continue;
    }
    occ.forEach(function (o) { out.push(ext(base, { start: o.start, end: o.end })); });
  }
  if (moved) { if (retried) fail('Calendar "' + c.name + '" kept changing while it was read.', 'Try again in a moment.'); return eventsIn(c, from, to, true); }
  return out;
}

var CALENDAR = {
  list_calendars: function () { return calendarList().map(function (c) { return { index: c.index, name: c.name, writable: c.writable }; }); },
  list_events: function (a) {
    var from = a.from || startOfDay(new Date()), to = a.to || addDays(from, 7);
    if (!a.to) note('No "to" given: showing 7 days from ' + iso(from).slice(0, 10) + '.');
    if (to <= from) fail('"to" (' + iso(to) + ') must be after "from" (' + iso(from) + ').');
    var list = calendarList(), one = pickCalendar(a, list), out = [];
    (one ? [one] : list).forEach(function (c) { checkCancelled(); out = out.concat(eventsIn(c, from, to)); });
    out.sort(function (x, y) { return x.start - y.start; });
    if (out.length > a.limit) note('Showing the first ' + a.limit + ' of ' + out.length + ' events; narrow the dates for the rest.');
    return out.slice(0, a.limit).map(function (ev) {
      var o = { uid: ev.uid, calendar: ev.calendar, calendar_index: ev.calendar_index, title: ev.title, start: iso(ev.start), end: iso(ev.end), all_day: ev.all_day, location: ev.location };
      if (ev.recurring) o.recurring = true;
      if (ev.note) { o.recurrence = ev.recurrence; o.note = ev.note; }
      return o;
    });
  },
  create_event: function (a) {
    var list = calendarList(), target = pickCalendar(a, list), writable = list.filter(function (c) { return c.writable; });
    if (!target) {
      if (writable.length !== 1) fail('Which calendar? ' + (writable.length ? 'Writable calendars: ' + writable.map(function (c) { return c.name + ' (index ' + c.index + ')'; }).join(', ') + '.' : 'No writable calendar found.'), 'Pass calendar (a name) or calendar_index.');
      target = writable[0];
      note('Using calendar "' + target.name + '", the only writable one.');
    }
    if (!target.writable) fail('Calendar "' + target.name + '" is read-only.', 'Writable: ' + writable.map(function (c) { return c.name; }).join(', ') + '.');
    var allDay = a.all_day != null ? a.all_day : !!a.start.dateOnly, start = a.start, end = a.end;
    if (allDay && !start.dateOnly) note('all_day: the time in "start" was dropped.');
    if (allDay) start = startOfDay(start);
    if (!end) { end = allDay ? addDays(start, 1) : new Date(start.getTime() + 3600e3); note('No "end" given: ' + (allDay ? 'one all-day event.' : 'one hour long.')); }
    else if (end.dateOnly) {
      if (!allDay) fail('"end" is a date without a time, but "start" has a time.', 'Give "end" a time, e.g. ' + iso(new Date(start.getTime() + 3600e3)) + ', or make it all_day:true.');
      end = addDays(startOfDay(end), 1); // a date-only end day is included
    }
    if (end <= start) fail('"end" (' + iso(end) + ') must be after "start" (' + iso(start) + ').');
    if (end - start > 366 * 864e5) fail('Events can be at most one year long here; this one runs ' + iso(start) + ' → ' + iso(end) + '.', 'Check "start" and "end".');
    if (a.start.localTime || (a.end && a.end.localTime)) note('No time zone given: used this Mac\'s time zone (UTC' + tzOffset(start) + ').');
    if (a.recurrence && parseRule(a.recurrence) === null && !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/.test(a.recurrence))
      fail('"recurrence" is not an iCalendar rule.', 'Give an RRULE like FREQ=WEEKLY;BYDAY=MO, or leave it out.');
    var props = { summary: a.title, startDate: start, endDate: end, alldayEvent: allDay };
    if (a.recurrence) props.recurrence = a.recurrence;
    if (a.location) props.location = a.location;
    if (a.notes) props.description = a.notes;
    var ev = cal().Event(props);
    target.ref.events.push(ev);
    EVENT_CACHE = {};
    return { created: a.title, calendar: target.name, calendar_index: target.index, start: iso(start), end: iso(end), all_day: allDay, uid: safe(function () { return ev.uid(); }, null) };
  },
  delete_event: function (a) {
    var list = calendarList(), one = pickCalendar(a, list), hits = [];
    (one ? [one] : list).forEach(function (c) {
      safe(function () { return c.ref.events.whose({ uid: a.uid })(); }, []).forEach(function (ev) {
        var rule; // a failed read must not pass as "does not repeat"
        try { rule = ev.recurrence() || ''; } catch (e) { if (e instanceof Cancelled) throw e; rule = null; }
        hits.push({ ref: ev, calendar: c, recurrence: rule, copy: {
          title: safe(function () { return ev.summary(); }, ''), start: iso(safe(function () { return ev.startDate(); }, null)), end: iso(safe(function () { return ev.endDate(); }, null)),
          all_day: safe(function () { return ev.alldayEvent(); }, null), location: safe(function () { return ev.location(); }, null) || null,
          notes: safe(function () { return ev.description(); }, null) || null, recurrence: rule || null,
          excluded_dates: rule ? safe(function () { return ev.excludedDates(); }, []).map(iso) : undefined,
          alarms: safe(function () { return ev.displayAlarms().length + ev.soundAlarms().length; }, null) } });
      });
    });
    if (!hits.length) fail('No event with uid ' + a.uid + (one ? ' in "' + one.name + '"' : '') + '.', 'Uids come from list_events.');
    if (hits.length > 1) fail('This uid is in ' + hits.length + ' calendars: ' + hits.map(function (h) { return h.calendar.name + ' (index ' + h.calendar.index + ')'; }).join(', ') + '. Nothing was deleted.', 'Pass calendar_index to delete one copy.');
    var h = hits[0];
    if (!h.calendar.writable) fail('Calendar "' + h.calendar.name + '" is read-only; the event cannot be deleted here.');
    if (h.recurrence === null) fail('Could not tell whether "' + h.copy.title + '" repeats, so nothing was deleted.', 'Try again; if it keeps failing, the user can delete it in Calendar.');
    if (h.recurrence && !a.whole_series) fail('"' + h.copy.title + '" repeats; deleting it removes every occurrence. Nothing was deleted.', 'Only if the user wants the whole series gone, call again with whole_series:true. Single occurrences cannot be deleted here.');
    checkCancelled();
    cal()['delete'](h.ref);
    EVENT_CACHE = {};
    note('Calendar has no trash for events. The deleted event is in "copy"; recreate it with create_event if the user asks (alarms, invitees and skipped dates are not restored).');
    return { deleted: h.copy.title, calendar: h.calendar.name, whole_series: !!h.recurrence, copy: h.copy };
  }
};

// ======================================================================
// Notes
// ======================================================================
var NotesApp = null;
function notes() { if (!NotesApp) NotesApp = Application('Notes'); return NotesApp; }
var DELETED_FOLDER = /^(Recently Deleted|Недавно удал[её]нные|Zuletzt gelöscht|Suppressions récentes|Eliminadas recientemente|Eliminate di recente)$/i;

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function toNoteHtml(text, isHtml) { // plain text → Notes HTML, one <div> per line
  if (isHtml) return String(text);
  return String(text).split('\n').map(function (l) { return '<div>' + (l ? esc(l) : '<br>') + '</div>'; }).join('');
}
function noteAccount(name) {
  var names = notes().accounts.name(), exact = pickName(name, names);
  if (!exact) fail('No Notes account "' + name + '".' + didYouMean(name, names), 'Notes accounts: ' + names.join(', ') + '.');
  return notes().accounts.byName(exact);
}
function noteFolder(account, folder) {
  var accs = account ? [noteAccount(account)] : notes().accounts(), hits = [], all = [];
  accs.forEach(function (acc) { acc.folders().forEach(function (f) { var n = f.name(); all.push(n); if (lower(n) === lower(folder)) hits.push({ ref: f, account: acc.name() }); }); });
  if (hits.length === 1) return hits[0].ref;
  if (hits.length > 1) fail('Folder "' + folder + '" is in several Notes accounts: ' + hits.map(function (h) { return h.account; }).join(', ') + '.', 'Pass "account".');
  fail('No Notes folder "' + folder + '"' + (account ? ' in ' + account : '') + '.' + didYouMean(folder, all), 'Folders: ' + all.join(', ') + '.');
}
function getNote(id) {
  var n = notes().notes.byId(String(id));
  if (!exists(n)) fail('No note with id "' + id + '".', 'Note ids look like x-coredata://…/ICNote/p123 and come from list_notes or search_notes.');
  return n;
}
function noteSummary(spec, limit, includeDeleted) {
  var ids = safe(function () { return spec.id(); }, []);
  if (!ids.length) return [];
  var names = spec.name(), mod = spec.modificationDate(), out = [];
  var order = ids.map(function (_, i) { return i; }).sort(function (x, y) { return (mod[y] || 0) - (mod[x] || 0); });
  for (var k = 0; k < order.length && out.length < limit; k++) {
    var i = order[k], folder = safe(function () { return spec[i].container().name(); }, null);
    if (!includeDeleted && folder && DELETED_FOLDER.test(folder)) continue;
    out.push({ id: ids[i], title: names[i], folder: folder, modified: iso(mod[i]) });
  }
  return out;
}

var NOTES_APP = {
  list_note_folders: function () {
    return notes().accounts().map(function (acc) {
      return { account: acc.name(), folders: acc.folders().map(function (f) { return { folder: f.name(), notes: safe(function () { return f.notes.length; }, 0) }; }) };
    });
  },
  list_notes: function (a) {
    var spec = a.folder ? noteFolder(a.account, a.folder).notes : (a.account ? noteAccount(a.account).notes : notes().notes);
    return noteSummary(spec, a.limit, !!a.folder || a.include_deleted); // a folder asked for by name is shown as is
  },
  search_notes: function (a) {
    var spec = (a.account ? noteAccount(a.account) : notes()).notes.whose({ _or: [{ name: { _contains: a.query } }, { plaintext: { _contains: a.query } }] });
    return noteSummary(spec, a.limit, a.include_deleted);
  },
  read_note: function (a) {
    var n = getNote(a.id), r = { id: a.id, title: n.name(), folder: safe(function () { return n.container().name(); }, null),
      created: iso(safe(function () { return n.creationDate(); }, null)), modified: iso(safe(function () { return n.modificationDate(); }, null)) };
    if (safe(function () { return n.passwordProtected(); }, false)) { r.locked = true; r.body = null; note('The note is locked; the user must unlock it in Notes first.'); return r; }
    var body = page(a.html ? n.body() : n.plaintext(), a.offset, a.max_chars);
    r.body = body.text; r.body_chars = body.total_chars; r.next_offset = body.next_offset;
    return r;
  },
  // The new note's id is the one id that was not in the folder before (titles can repeat).
  create_note: function (a) {
    var N = notes(), target = a.folder ? noteFolder(a.account, a.folder) : (a.account ? noteAccount(a.account).defaultFolder() : N.defaultAccount().defaultFolder());
    var before = {}; safe(function () { return target.notes.id(); }, []).forEach(function (id) { before[id] = 1; });
    target.notes.push(N.Note({ body: '<div><h1>' + esc(a.title) + '</h1></div>' + (a.body ? toNoteHtml(a.body, a.html) : '') }));
    var fresh = safe(function () { return target.notes.id(); }, []).filter(function (id) { return !before[id]; });
    if (fresh.length !== 1) note('Could not tell which note is new; find it with search_notes before changing it.');
    return { created: true, id: fresh.length === 1 ? fresh[0] : null, title: a.title, folder: target.name() };
  },
  update_note: function (a) {
    var n = getNote(a.id);
    if (safe(function () { return n.passwordProtected(); }, false)) fail('The note is locked.', 'The user must unlock it in Notes first.');
    var files = a.append ? 0 : safe(function () { return n.attachments.length; }, null);
    if (files === null) fail('Could not tell whether the note has attachments, so nothing was changed.', 'Try again, or use append:true to add text.');
    if (files) fail('The note has ' + files + ' attachment(s) (images, files, drawings); replacing its body would drop them. Nothing was changed.', 'Use append:true to add text, or let the user edit the note in Notes.');
    var add = toNoteHtml(a.body, a.html);
    if (a.append) n.body = n.body() + add;
    else n.body = '<div><h1>' + esc(a.title || n.name()) + '</h1></div>' + add;
    return { updated: true, id: a.id, title: n.name(), appended: a.append };
  },
  // Only where Notes keeps a Recently Deleted folder (iCloud, On My Mac); elsewhere deleting is permanent.
  delete_note: function (a) {
    var n = getNote(a.id), title = n.name(), folder = n.container();
    if (safe(function () { return n.passwordProtected(); }, false)) fail('"' + title + '" is locked.', 'The user must unlock it in Notes first, or delete it there.');
    if (DELETED_FOLDER.test(safe(function () { return folder.name(); }, ''))) fail('"' + title + '" is already in Recently Deleted; deleting it there is permanent, so this tool will not do it.');
    // Recently Deleted exists only in upgraded accounts (iCloud, On My Mac); a folder with that name elsewhere proves nothing.
    var account = safe(function () { return folder.container(); }, null), accName = safe(function () { return account.name(); }, '?');
    var recoverable = safe(function () { return account.upgraded(); }, false) && safe(function () { return account.folders.name().some(function (f) { return DELETED_FOLDER.test(f); }); }, false);
    if (!recoverable) fail('Notes account "' + accName + '" keeps no Recently Deleted, so deleting would be permanent. Nothing was deleted.', 'The user can delete it in Notes.');
    checkCancelled();
    notes()['delete'](n);
    return { deleted: title, recoverable: 'in Recently Deleted for about 30 days' };
  }
};

// ======================================================================
// ACTIONS — the one registry. tool: read|write; guard: refuse exact repeats; args: specs (see coerce).
// ======================================================================
var MSG = {
  id: { type: 'id', required: true, desc: 'message id from list_messages / search_messages' },
  account: { type: 'string', desc: 'account from the same row' },
  mailbox: { type: 'string', 'default': 'INBOX', desc: 'folder from the same row, default INBOX' }
};
var MANY = { ids: { type: 'ids', desc: 'message ids, e.g. [123, 456]' }, id: { type: 'id', desc: 'or one id' }, account: MSG.account, mailbox: MSG.mailbox };
function LIMIT(d, max) { return { type: 'integer', 'default': d, min: 1, max: max || 100, desc: 'default ' + d }; }
var PAGE = { offset: { type: 'integer', 'default': 0, min: 0, desc: 'where to start in long text (next_offset)' }, max_chars: { type: 'integer', 'default': 12000, min: 200, max: 60000, desc: 'default 12000' } };
var DAYS = { type: 'integer', 'default': 14, min: 1, max: 365, desc: 'look back, default 14' };

var ACTIONS = {
  // ---- Mail: read
  list_accounts: { tool: 'read', desc: 'Mail accounts and their addresses.', args: {}, run: MAIL.list_accounts },
  list_mailboxes: { tool: 'read', desc: 'Folders of an account, with role (inbox, sent, trash…) and unread count.', args: { account: { type: 'string', required: true } }, run: MAIL.list_mailboxes },
  list_messages: { tool: 'read', desc: 'Newest messages in a folder. No account = all inboxes. Rows show replied/forwarded/flagged.',
    args: { account: MSG.account, mailbox: MSG.mailbox, unread: { type: 'boolean', 'default': false }, limit: LIMIT(20) }, run: MAIL.list_messages },
  search_messages: { tool: 'read', desc: 'Search mail by text and filters. Searches the inbox unless mailbox is given or all_mailboxes:true.',
    args: { query: { type: 'string', desc: 'text to find' }, 'in': { type: 'string', values: ['subject_sender', 'subject', 'sender', 'body', 'any'], 'default': 'subject_sender', desc: 'where to look for query; body is slower' },
      from: { type: 'string', desc: 'sender contains' }, subject: { type: 'string', desc: 'subject contains' },
      account: MSG.account, mailbox: { type: 'string' }, all_mailboxes: { type: 'boolean', 'default': false, desc: 'every folder except Trash, Junk, Drafts and Outbox' },
      from_date: { type: 'date', desc: 'e.g. 2026-10-01 or "7 days ago"' }, to_date: { type: 'date', endOfDay: true },
      unread: { type: 'boolean' }, flagged: { type: 'boolean' }, has_attachments: { type: 'boolean' }, limit: LIMIT(20) }, run: MAIL.search_messages },
  awaiting_reply: { tool: 'read', desc: 'Emails you sent that nobody you wrote to has answered. Check this before saying "they never replied".',
    args: { days: DAYS, account: MSG.account, limit: LIMIT(30) }, run: MAIL.awaiting_reply },
  needs_response: { tool: 'read', desc: 'Inbox emails from people that wait for YOUR answer. Skips no-reply and notification senders.',
    args: { days: DAYS, account: MSG.account, limit: LIMIT(30) }, run: MAIL.needs_response },
  get_thread: { tool: 'read', desc: 'The whole conversation of a message, oldest first, with your sent replies.',
    args: ext(MSG, { bodies: { type: 'boolean', 'default': true }, max_chars: { type: 'integer', 'default': 2000, min: 200, max: 20000, desc: 'per message, default 2000' }, limit: LIMIT(30) }), run: MAIL.get_thread },
  list_attachments: { tool: 'read', desc: 'Attachments of a message: name, size, type.', args: MSG, run: MAIL.list_attachments },
  read_message: { tool: 'read', desc: 'One message: headers, attachments and text (long text is paged with offset).', args: ext(MSG, PAGE), run: MAIL.read_message },
  list_rules: { tool: 'read', desc: 'Mail rules with conditions and actions.', args: {}, run: MAIL.list_rules },
  // ---- Mail: write
  send_email: { tool: 'write', guard: true, desc: 'Send a new email. draft:true only opens it in Mail for the user to send.',
    args: { to: { type: 'addresses', required: true, desc: 'addresses, comma separated' }, cc: { type: 'addresses' }, bcc: { type: 'addresses' },
      subject: { type: 'string', required: true }, body: { type: 'string', required: true, desc: 'plain text' },
      from: { type: 'string', desc: 'one of your addresses; default: Mail decides' }, draft: { type: 'boolean', 'default': false } }, run: MAIL.send_email },
  reply_message: { tool: 'write', guard: true, desc: 'Reply to a message. Opens as a draft in Mail (Mail adds recipients and the quote); draft:false sends right away.',
    args: ext(MSG, { body: { type: 'string', required: true, desc: 'your reply text' }, reply_all: { type: 'boolean', 'default': false }, draft: { type: 'boolean', 'default': true, desc: 'default true' } }), run: MAIL.reply_message },
  forward_message: { tool: 'write', guard: true, desc: 'Forward a message with its attachments and an optional note. Opens as a draft; draft:false sends.',
    args: ext(MSG, { to: { type: 'addresses', required: true }, cc: { type: 'addresses' }, bcc: { type: 'addresses' }, body: { type: 'string', desc: 'note above the forwarded text' }, draft: { type: 'boolean', 'default': true, desc: 'default true' } }), run: MAIL.forward_message },
  set_read: { tool: 'write', desc: 'Mark messages read (read:true) or unread (read:false).', args: ext(MANY, { read: { type: 'boolean', required: true } }), run: MAIL.set_read },
  set_flag: { tool: 'write', desc: 'Flag messages (optional color) or unflag them (flagged:false).',
    args: ext(MANY, { flagged: { type: 'boolean', 'default': true }, color: { type: 'string', values: ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'], valueAliases: { grey: 'gray', violet: 'purple' } } }), run: MAIL.set_flag },
  move_messages: { tool: 'write', desc: 'Move messages to another folder. dry_run:true only shows what would move.',
    args: ext(MANY, { to_mailbox: { type: 'string', required: true, desc: 'destination folder' }, to_account: { type: 'string', desc: 'default: same account' }, dry_run: { type: 'boolean', 'default': false } }), run: MAIL.move_messages },
  delete_messages: { tool: 'write', guard: true, desc: 'Move messages to their account\'s Trash (recoverable). dry_run:true only shows what would go.',
    args: ext(MANY, { dry_run: { type: 'boolean', 'default': false } }), run: MAIL.delete_messages },
  save_attachments: { tool: 'write', guard: true, desc: 'Save attachments into the attachments folder (extension settings, default ~/Downloads). Never overwrites.',
    args: ext(MSG, { names: { type: 'list', desc: 'only these file names; default all' }, dir: { type: 'string', desc: 'subfolder of the attachments folder' } }), run: MAIL.save_attachments },
  create_mailbox: { tool: 'write', guard: true, desc: 'Create a folder. "Parent/Child" creates both levels.',
    args: { account: { type: 'string', required: true }, name: { type: 'string', required: true, aliases: ['mailbox', 'folder', 'folder_name', 'title'] } }, run: MAIL.create_mailbox },
  create_rule: { tool: 'write', guard: true, desc: 'Create a Mail rule: conditions plus actions (move_to, mark_read, flag, delete, stop).',
    args: { name: { type: 'string', required: true, aliases: ['rule', 'rule_name', 'title'] }, match: { type: 'string', values: ['all', 'any'], 'default': 'all' },
      conditions: { type: 'objects', required: true, desc: 'list of {field, op, value}', props: {
        field: { type: 'string', required: true, values: ['from', 'to', 'cc', 'subject', 'any_recipient', 'content'], aliases: ['header', 'where'],
          valueAliases: { sender: 'from', recipient: 'any_recipient', recipients: 'any_recipient', body: 'content', text: 'content', message: 'content' } },
        op: { type: 'string', values: ['contains', 'not_contains', 'begins', 'ends', 'equals'], 'default': 'contains', aliases: ['operator', 'qualifier', 'type', 'match'],
          valueAliases: { is: 'equals', equal: 'equals', '=': 'equals', '==': 'equals', starts_with: 'begins', begins_with: 'begins', ends_with: 'ends', does_not_contain: 'not_contains', doesnt_contain: 'not_contains', excludes: 'not_contains', includes: 'contains', has: 'contains' } },
        value: { type: 'string', required: true, aliases: ['expression', 'text', 'pattern', 'contains'] } } },
      move_to: { type: 'object', desc: '{account, mailbox}', props: { account: { type: 'string', required: true }, mailbox: { type: 'string', required: true } },
        fromString: function (s) { var p = s.split('/'); return p.length > 1 && pickName(p[0], accountNames()) ? { account: p[0], mailbox: p.slice(1).join('/') } : { mailbox: s }; } },
      mark_read: { type: 'boolean' }, flag: { type: 'boolean' }, 'delete': { type: 'boolean' }, stop: { type: 'boolean' }, enabled: { type: 'boolean', 'default': true } }, run: MAIL.create_rule },
  set_rule_enabled: { tool: 'write', desc: 'Turn a rule on (enabled:true) or off (enabled:false).', args: { name: { type: 'string', required: true, aliases: ['rule'] }, enabled: { type: 'boolean', required: true } }, run: MAIL.set_rule_enabled },
  delete_rule: { tool: 'write', guard: true, desc: 'Delete a rule by name. Permanent in Mail; the result holds a copy of the rule.', args: { name: { type: 'string', required: true, aliases: ['rule'] } }, run: MAIL.delete_rule },
  // ---- Calendar
  list_calendars: { tool: 'read', desc: 'Calendars with index (use it when two share a name) and whether they are writable.', args: {}, run: CALENDAR.list_calendars },
  list_events: { tool: 'read', desc: 'Events from "from" to "to", repeating events included. No calendar = all calendars.',
    args: { from: { type: 'date', desc: 'default today', aliases: ['start', 'date', 'day', 'on'] }, to: { type: 'date', endOfDay: true, desc: 'default 7 days after from', aliases: ['end'] },
      calendar: { type: 'string' }, calendar_index: { type: 'integer', min: 0 }, limit: LIMIT(100, 500) }, run: CALENDAR.list_events },
  create_event: { tool: 'write', guard: true, desc: 'Create an event. start/end: ISO 8601 with time zone, e.g. 2026-10-27T13:00:00-06:00. A date alone makes an all-day event.',
    args: { title: { type: 'string', required: true }, start: { type: 'date', required: true, aliases: ['from', 'date', 'when', 'start_date', 'on'] }, end: { type: 'date', desc: 'default: 1 hour after start', aliases: ['to', 'end_date', 'until'] },
      all_day: { type: 'boolean' }, calendar: { type: 'string', desc: 'needed when several calendars are writable' }, calendar_index: { type: 'integer', min: 0 },
      location: { type: 'string' }, notes: { type: 'string' }, recurrence: { type: 'string', desc: 'iCalendar RRULE, e.g. FREQ=WEEKLY;BYDAY=MO' } }, run: CALENDAR.create_event },
  delete_event: { tool: 'write', guard: true, desc: 'Delete an event by uid (from list_events). Permanent in Calendar; the result holds a copy. A repeating event needs whole_series:true.',
    args: { uid: { type: 'string', required: true, aliases: ['id'] }, calendar: { type: 'string' }, calendar_index: { type: 'integer', min: 0 }, whole_series: { type: 'boolean', 'default': false } }, run: CALENDAR.delete_event },
  // ---- Notes
  list_note_folders: { tool: 'read', desc: 'Notes accounts and folders with note counts.', args: {}, run: NOTES_APP.list_note_folders },
  list_notes: { tool: 'read', desc: 'Notes, newest first. Skips Recently Deleted unless include_deleted:true.',
    args: { folder: { type: 'string' }, account: { type: 'string', desc: 'Notes account, e.g. iCloud' }, include_deleted: { type: 'boolean', 'default': false }, limit: LIMIT(30) }, run: NOTES_APP.list_notes },
  search_notes: { tool: 'read', desc: 'Notes whose title or text contains query.',
    args: { query: { type: 'string', required: true }, account: { type: 'string' }, include_deleted: { type: 'boolean', 'default': false }, limit: LIMIT(20) }, run: NOTES_APP.search_notes },
  read_note: { tool: 'read', desc: 'A note as plain text (html:true for HTML). Long notes are paged with offset.',
    args: ext({ id: { type: 'string', required: true, desc: 'note id from list_notes / search_notes' }, html: { type: 'boolean', 'default': false } }, PAGE), run: NOTES_APP.read_note },
  create_note: { tool: 'write', guard: true, desc: 'Create a note. body is plain text (lines kept) unless html:true.',
    args: { title: { type: 'string', required: true }, body: { type: 'string' }, html: { type: 'boolean', 'default': false }, folder: { type: 'string', desc: 'default: the account\'s default folder' }, account: { type: 'string' } }, run: NOTES_APP.create_note },
  update_note: { tool: 'write', guard: true, desc: 'Change a note: append:true adds text at the end, otherwise the body is replaced (title kept unless given).',
    args: { id: { type: 'string', required: true }, body: { type: 'string', required: true }, html: { type: 'boolean', 'default': false }, append: { type: 'boolean', 'default': false }, title: { type: 'string' } }, run: NOTES_APP.update_note },
  delete_note: { tool: 'write', guard: true, desc: 'Delete a note into Recently Deleted (recoverable). Refuses where deleting would be permanent.',
    args: { id: { type: 'string', required: true } }, run: NOTES_APP.delete_note }
};

// Words small models use for actions. Write actions are reached only by exact name or these aliases, never by guessing.
var ACTION_ALIASES = {
  accounts: 'list_accounts', folders: 'list_mailboxes', mailboxes: 'list_mailboxes', list_folders: 'list_mailboxes',
  inbox: 'list_messages', messages: 'list_messages', list: 'list_messages', list_emails: 'list_messages', get_messages: 'list_messages', recent: 'list_messages', list_mail: 'list_messages',
  search: 'search_messages', find: 'search_messages', search_mail: 'search_messages', search_emails: 'search_messages', find_messages: 'search_messages', find_emails: 'search_messages',
  read: 'read_message', open: 'read_message', get_message: 'read_message', read_email: 'read_message', get_email: 'read_message', show_message: 'read_message', read_mail: 'read_message',
  thread: 'get_thread', conversation: 'get_thread', attachments: 'list_attachments', rules: 'list_rules',
  unanswered: 'needs_response', to_answer: 'needs_response', need_reply: 'needs_response', needs_reply: 'needs_response',
  no_reply: 'awaiting_reply', waiting: 'awaiting_reply', waiting_for_reply: 'awaiting_reply',
  calendars: 'list_calendars', events: 'list_events', agenda: 'list_events', get_events: 'list_events', schedule_list: 'list_events',
  notes: 'list_notes', note_folders: 'list_note_folders', find_notes: 'search_notes', get_note: 'read_note', open_note: 'read_note',
  send: 'send_email', send_mail: 'send_email', compose: 'send_email', draft: 'send_email', draft_email: 'send_email', new_email: 'send_email', email: 'send_email', send_message: 'send_email', write_email: 'send_email',
  reply: 'reply_message', respond: 'reply_message', answer: 'reply_message', reply_email: 'reply_message', reply_to_message: 'reply_message',
  forward: 'forward_message', forward_email: 'forward_message', mark_read: 'set_read', mark_unread: 'set_read', mark_as_read: 'set_read', mark_as_unread: 'set_read',
  flag: 'set_flag', flag_message: 'set_flag', unflag: 'set_flag', move: 'move_messages', move_message: 'move_messages',
  delete: 'delete_messages', trash: 'delete_messages', delete_message: 'delete_messages', delete_email: 'delete_messages',
  save_attachment: 'save_attachments', download_attachments: 'save_attachments', new_folder: 'create_mailbox', create_folder: 'create_mailbox',
  new_rule: 'create_rule', add_rule: 'create_rule', enable_rule: 'set_rule_enabled', disable_rule: 'set_rule_enabled',
  new_event: 'create_event', add_event: 'create_event', schedule: 'create_event', remove_event: 'delete_event',
  new_note: 'create_note', add_note: 'create_note', edit_note: 'update_note', append_note: 'update_note', remove_note: 'delete_note'
};
var ALIAS_PRESETS = { // what an alias implies, unless the args say otherwise
  compose: { draft: true }, new_email: { draft: true }, write_email: { draft: true }, draft: { draft: true }, draft_email: { draft: true },
  mark_read: { read: true }, mark_as_read: { read: true }, mark_unread: { read: false }, mark_as_unread: { read: false },
  unflag: { flagged: false }, enable_rule: { enabled: true }, disable_rule: { enabled: false }, append_note: { append: true }
};

// ======================================================================
// dispatch
// ======================================================================
function actionsOf(tool) { return Object.keys(ACTIONS).filter(function (n) { return ACTIONS[n].tool === tool; }); }
function exampleCall(name) {
  var spec = ACTIONS[name], ex = {};
  Object.keys(spec.args).filter(function (k) { return spec.args[k].required; }).forEach(function (k) {
    var t = spec.args[k].type;
    ex[k] = t === 'id' ? 123 : t === 'boolean' ? true : t === 'ids' ? [123] : t === 'objects' ? [{ field: 'from', value: 'x' }] : '…';
  });
  return spec.tool + ' {"action": "' + name + '", "args": ' + JSON.stringify(ex) + '}';
}
function resolveAction(tool, raw) {
  if (raw == null || raw === '') fail('Missing "action".', 'Call ' + tool + ' with {"action": "<name>", "args": {…}}. Actions: ' + actionsOf(tool).join(', ') + '.');
  if (typeof raw !== 'string') fail('"action" must be an action name, e.g. "list_messages".');
  var name = snake(trim(raw)), presets = null;
  if (!ACTIONS[name] && ACTION_ALIASES[name]) { presets = ALIAS_PRESETS[name] || null; note('Action "' + raw + '" is "' + ACTION_ALIASES[name] + '".'); name = ACTION_ALIASES[name]; }
  if (!ACTIONS[name]) {
    var g = closest(name, Object.keys(ACTIONS))[0];
    if (g && tool === 'read' && ACTIONS[g].tool === 'read') { note('Action "' + raw + '" is "' + g + '".'); name = g; } // a read is safe to guess
    else fail('Unknown action "' + raw + '".' + (g ? ' Did you mean "' + g + '" (' + ACTIONS[g].tool + ' tool)?' : ''), tool + ' actions: ' + actionsOf(tool).join(', ') + '.');
  }
  if (ACTIONS[name].tool === 'write' && tool !== 'write') {
    if (READ_ONLY) fail('"' + name + '" changes things, and read-only mode is on (extension settings).', 'Tell the user this is disabled.');
    fail('"' + name + '" belongs to the write tool, not read.', 'Call ' + exampleCall(name) + '.');
  }
  return { name: name, presets: presets };
}
function splitInput(input) { // {action, args} from whatever shape the model sent
  if (typeof input === 'string') input = safe(function () { return JSON.parse(input); }, { action: input });
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Call with {"action": "<name>", "args": {…}}.');
  var argKey = ['args', 'params', 'arguments', 'parameters', 'input'].filter(function (k) { return input[k] !== undefined; })[0];
  var args = argKey ? input[argKey] : {};
  if (typeof args === 'string') {
    var parsed = safe(function () { return JSON.parse(args); }, undefined);
    if (parsed === undefined) fail('"args" must be an object like {"id": 123}, got text: ' + args.slice(0, 80));
    args = parsed;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('"args" must be an object like {"id": 123}.');
  args = ext(args, {});
  if (input.action !== undefined && args.action !== undefined && stableJSON(input.action) !== stableJSON(args.action))
    fail('Two different actions: "' + input.action + '" and args.action "' + args.action + '". Give one.');
  var action = input.action !== undefined ? input.action : args.action !== undefined ? args.action : input.name;
  delete args.action;
  var flat = Object.keys(input).filter(function (k) { return k !== 'action' && k !== argKey && !(k === 'name' && input.action === undefined); });
  if (flat.length) {
    flat.forEach(function (k) {
      if (args[k] !== undefined && stableJSON(args[k]) !== stableJSON(input[k])) fail('"' + k + '" is given twice with different values (next to "action" and inside "args"). Give it once, inside "args".');
      args[k] = input[k];
    });
    note('Arguments belong inside "args": {"action": "…", "args": {…}}.');
  }
  return { action: action, args: args };
}

// Small models loop. A guarded write that already succeeded with the same arguments within 15 minutes is
// refused (repeat:true overrides); a read repeated within a minute gets a note to use the earlier result.
var DONE = [], REPEAT_WINDOW_MS = 15 * 60e3, LAST_READ = { key: null, at: 0 };
function callPublic(tool, input) {
  NOTES = [];
  if (tool !== 'read' && tool !== 'write') fail('No tool "' + tool + '". Tools: read, write.');
  if (tool === 'write' && READ_ONLY) fail('Read-only mode is on (extension settings): changes are disabled.', 'Tell the user; only the read tool works.');
  var call = splitInput(input || {}), found = resolveAction(tool, call.action), spec = ACTIONS[found.name], args = call.args;
  if (found.presets) Object.keys(found.presets).forEach(function (k) { if (args[k] === undefined) args[k] = found.presets[k]; });
  var repeat = args.repeat !== undefined && TRUE_WORDS.test(String(args.repeat));
  delete args.repeat;
  var a = normaliseArgs(args, spec.args, 'args', spec.tool === 'write');

  var key = found.name + ' ' + stableJSON(a), now = Date.now();
  if (spec.guard && !a.dry_run) {
    DONE = DONE.filter(function (d) { return now - d.at < REPEAT_WINDOW_MS; });
    var prev = DONE.filter(function (d) { return d.key === key; })[0];
    if (prev && !repeat) fail('This exact ' + found.name + ' call already succeeded ' + Math.max(1, Math.round((now - prev.at) / 60e3)) + ' min ago, so it was not done again.',
      'Use the earlier result. Only if the user explicitly asked to do it again, add "repeat": true to args.');
  }
  if (spec.tool === 'read') {
    if (LAST_READ.key === key && now - LAST_READ.at < 60e3) note('You just made this same call. Use that result instead of calling again.');
    LAST_READ = { key: key, at: now };
  }
  if (spec.tool === 'write') checkCancelled(); // last chance before anything changes
  var result = spec.run(a);
  if (spec.guard && !a.dry_run) DONE.push({ key: key, at: now });
  return result;
}
function formatResult(result) {
  var out = Array.isArray(result) ? { count: result.length, items: result } : (result && typeof result === 'object' ? result : { status: String(result) });
  if (Array.isArray(result) && !result.length) out.guidance = 'Nothing found. Tell the user, or change the search; do not repeat the same call.';
  if (NOTES.length) out.notes = NOTES.slice();
  return JSON.stringify(out, null, 1);
}
function formatError(e) {
  if (e instanceof UserError) return 'Error: ' + e.message + (e.hint ? '\nHow to fix: ' + e.hint : '') + (NOTES.length ? '\nNotes: ' + NOTES.join(' ') : '');
  var text = errorText(e);
  return 'Error from macOS: ' + text + (/not allowed|not authori[sz]ed|-1743|-10004|permission/i.test(text)
    ? '\nThe user must allow access in System Settings → Privacy & Security → Automation.' : '\nTry once more; if it repeats, tell the user what failed.');
}

// ---------- the two public tools ----------
function describe(names) {
  return names.map(function (n) {
    var a = ACTIONS[n].args, args = Object.keys(a).map(function (k) {
      var s = a[k];
      return k + (s.required ? '*' : '') + ':' + (s.values ? s.values.join('|') : s.type) + (s.desc ? ' (' + s.desc + ')' : '');
    }).join(', ');
    return '• ' + n + ' — ' + ACTIONS[n].desc + (args ? ' Args: ' + args : '');
  }).join('\n');
}
function publicTool(name, title, right, wrong, annotations) {
  var names = actionsOf(name);
  return { name: name, annotations: annotations,
    description: title + '\nCall with {"action": "<name>", "args": {…}}. * = required.\nRIGHT: ' + right + '\nWRONG: ' + wrong + ' — args go inside "args".\n' + describe(names),
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', 'enum': names },
      args: { type: 'object', description: 'arguments of the chosen action' } }, required: ['action'] } };
}
var PUBLIC_TOOLS = [
  publicTool('read', 'Read Apple Mail, Calendar and Notes. Never changes anything.',
    '{"action": "read_message", "args": {"id": 123, "account": "iCloud", "mailbox": "INBOX"}}', '{"action": "read_message", "id": 123}',
    { title: 'Read mail, calendar & notes', readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  publicTool('write', 'Change Apple Mail, Calendar and Notes: send, reply, forward, organize mail, rules, events, notes.',
    '{"action": "set_read", "args": {"ids": [123], "account": "iCloud", "read": true}}', '{"action": "set_read", "ids": [123]}',
    { title: 'Change mail, calendar & notes', readOnlyHint: false, destructiveHint: true, openWorldHint: true })
];
if (READ_ONLY) PUBLIC_TOOLS = PUBLIC_TOOLS.filter(function (t) { return t.name === 'read'; });
var INSTRUCTIONS = 'Apple Mail, Calendar and Notes on this Mac. The read tool looks, the write tool changes. ' +
  'Copy id, account and mailbox together from the same result row. Replies and forwards open as drafts unless draft:false: tell the user to press Send in Mail. ' +
  'Never repeat a call that succeeded. If a result has "notes", follow them. Ask the user before sending or deleting anything they did not clearly ask for.';

// ======================================================================
// JSON-RPC
// ======================================================================
var PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; // newest first
function handle(req) {
  var id = req.id, method = req.method, p = req.params || {};
  try {
    if (method === 'initialize') {
      var want = p.protocolVersion;
      return send({ jsonrpc: '2.0', id: id, result: {
        protocolVersion: PROTOCOL_VERSIONS.indexOf(want) >= 0 ? want : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} }, serverInfo: { name: 'apple-mail-jxa', version: VERSION }, instructions: INSTRUCTIONS } });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id: id, result: { tools: PUBLIC_TOOLS } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id: id, result: {} });
    if (method === 'tools/call') {
      var names = PUBLIC_TOOLS.map(function (t) { return t.name; });
      if (typeof p.name !== 'string' || names.indexOf(p.name) < 0)
        return send({ jsonrpc: '2.0', id: id, error: { code: -32602, message: 'Unknown tool: ' + p.name + '. Tools: ' + names.join(', ') + (READ_ONLY ? ' (read-only mode is on)' : '') } });
      if (p.arguments !== undefined && (p.arguments === null || typeof p.arguments !== 'object' || Array.isArray(p.arguments)))
        return send({ jsonrpc: '2.0', id: id, error: { code: -32602, message: 'tools/call arguments must be an object: {"action": "…", "args": {…}}' } });
      var out;
      try {
        out = { content: [{ type: 'text', text: formatResult(callPublic(p.name, p.arguments)) }] };
      } catch (e) {
        if (e instanceof Cancelled) { log('cancelled request ' + id); return; } // a cancelled request gets no response
        out = { isError: true, content: [{ type: 'text', text: formatError(e) }] };
      }
      return send({ jsonrpc: '2.0', id: id, result: out });
    }
    send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    send({ jsonrpc: '2.0', id: id, error: { code: -32603, message: errorText(e) } });
  }
}

// ---------- stdio with cancellation ----------
// Handlers are synchronous Apple Events. stdin is read in the background (run loop notifications), so a
// cancellation that arrives while one request runs is seen before the next starts, and at the
// checkpoints right before anything irreversible (checkCancelled()).
function Cancelled() {}
var QUEUE = [], CANCELLED = Object.create(null), CURRENT = null, EOF = false;
var inBuf = $.NSMutableData.alloc.init;
function idKey(id) { return typeof id + ':' + String(id); }
function isRequestId(id) { return typeof id === 'string' || (typeof id === 'number' && isFinite(id)); }
function onMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  var hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (typeof msg.method !== 'string' && hasId && ('result' in msg || 'error' in msg)) return; // a response to us: nothing to do
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (hasId && !isRequestId(msg.id)))
    return send({ jsonrpc: '2.0', id: hasId && isRequestId(msg.id) ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } });
  if (!hasId) { // notification: never answered
    if (msg.method === 'notifications/cancelled' && msg.params && isRequestId(msg.params.requestId)) {
      var k = idKey(msg.params.requestId);
      // only ids that are queued or running, so a stale cancel can never hit a later request
      if ((CURRENT && CURRENT.key === k) || QUEUE.some(function (r) { return r.key === k; })) CANCELLED[k] = true;
    }
    return;
  }
  QUEUE.push({ key: idKey(msg.id), msg: msg });
}
function onChunk(data) {
  inBuf.appendData(data);
  var str = $.NSString.alloc.initWithDataEncoding(inBuf, $.NSUTF8StringEncoding);
  if (!str || str.isNil()) return; // partial UTF-8 sequence, wait for more
  str = str.js;
  var nl = str.lastIndexOf('\n');
  if (nl < 0) return;
  var complete = str.slice(0, nl), rest = str.slice(nl + 1);
  inBuf = $.NSMutableData.alloc.init;
  if (rest.length) inBuf.appendData($(rest).dataUsingEncoding($.NSUTF8StringEncoding));
  complete.split('\n').forEach(function (line) {
    line = line.trim();
    if (!line) return;
    var msg;
    try { msg = JSON.parse(line); } catch (e) { log('bad json: ' + line.slice(0, 200)); return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    onMessage(msg);
  });
}
ObjC.registerSubclass({ name: 'AppleMailMCPStdin', methods: { 'onData:': { types: ['void', ['id']], implementation: function (n) {
  var d = n.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
  if (!d || Number(d.length) === 0) { EOF = true; return; } // NSData.length bridges as a string
  try { onChunk(d); } catch (e) { log('input error: ' + errorText(e)); }
  n.object.readInBackgroundAndNotify;
} } } });
function pump(seconds) { $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(seconds)); }
function checkCancelled() {
  pump(0);
  if (CURRENT && CANCELLED[CURRENT.key]) throw new Cancelled();
}
function run() {
  var stdin = $.NSFileHandle.fileHandleWithStandardInput;
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject($.AppleMailMCPStdin.alloc.init, 'onData:', $.NSFileHandleReadCompletionNotification, stdin);
  stdin.readInBackgroundAndNotify;
  log('started ' + VERSION + (READ_ONLY ? ' (read-only)' : ''));
  while (true) {
    if (!QUEUE.length) { if (EOF) break; pump(60); continue; }
    pump(0); // cancellations that arrived while the previous request ran
    var r = QUEUE.shift();
    if (CANCELLED[r.key]) { delete CANCELLED[r.key]; log('skipped cancelled request ' + r.msg.id); continue; }
    CURRENT = r;
    try { handle(r.msg); } finally { delete CANCELLED[r.key]; CURRENT = null; }
  }
  log('stdin closed, exiting');
}
