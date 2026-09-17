#!/usr/bin/env node
// Claude Pulse — live dashboard for your Claude Code sessions.
// Zero dependencies. Reads local Claude data, pushes updates over SSE, raises Windows toasts.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.PULSE_PORT) || 4319;
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const LIVE_DIR = path.join(HOME, '.claude', 'sessions');
const DESKTOP_DIR = path.join(APPDATA, 'Claude', 'claude-code-sessions');
const CLI_DIR = path.join(APPDATA, 'Claude', 'claude-code');
const BRIEF_CWD = path.join(os.tmpdir(), 'claude-pulse-brief');
const DATA_FILE = path.join(__dirname, 'pulse-data.json'); // your Done / Drop / Keep decisions
const CLOUD_CONFIG_FILE = path.join(__dirname, 'pulse-cloud.json'); // optional: { supabaseUrl, pulseToken }
const CLOUD_SYNC_MS = 15_000;
const HOST_NAME = os.hostname();

const SCAN_MS = 1500;
const ACTIVE_WINDOW_MS = 90_000;   // transcript written this recently => still working (when no live process file)
const TIMELINE_MAX = 40;
const IS_WIN = process.platform === 'win32';

let toastsEnabled = process.env.PULSE_TOASTS !== '0';

// ---------------------------------------------------------------- state

const sessions = new Map();   // cliSessionId -> parsed transcript state
let desktopMeta = new Map();  // cliSessionId -> desktop app metadata
let deletedIds = new Set();
let liveProcs = new Map();    // cliSessionId -> { pid, status, updatedAt }
const clients = new Set();
let lastSnapshotJson = '';
let firstScanDone = false;

const clip = (t, n) => {
  if (!t) return '';
  t = String(t).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function newSession(id, file) {
  return {
    id, file, offset: 0, rest: Buffer.alloc(0), mtime: 0,
    cwd: '', branch: '', model: '', aiTitle: '', customTitle: '',
    firstPrompt: '', lastPrompt: '', lastPromptTs: 0, lastReply: '', notice: '',
    lastTool: null, phase: '', prompts: 0, tools: 0, outTokens: 0,
    firstTs: 0, lastTs: 0, pathHits: new Map(), timeline: [],
    promptLog: [], days: new Map(),
    status: '', pendingStatus: '', pendingCount: 0,
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// per-day activity bucket, used by the History view
function day(s, ts) {
  if (!ts) return null;
  const k = dayKey(ts);
  let b = s.days.get(k);
  if (!b) { b = { prompts: 0, tools: 0, tokens: 0, files: new Set(), firstTs: ts, lastTs: ts }; s.days.set(k, b); }
  if (ts < b.firstTs) b.firstTs = ts;
  if (ts > b.lastTs) b.lastTs = ts;
  return b;
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ---------------------------------------------------------------- transcript parsing

function pushTimeline(s, ev) {
  s.timeline.push(ev);
  if (s.timeline.length > TIMELINE_MAX) s.timeline.splice(0, s.timeline.length - TIMELINE_MAX);
}

function notePath(s, p) {
  if (!s.cwd || typeof p !== 'string') return;
  const cwd = s.cwd.replace(/[\\/]+$/, '');
  if (!p.toLowerCase().startsWith(cwd.toLowerCase())) return;
  const parts = p.slice(cwd.length).split(/[\\/]/).filter(Boolean);
  if (!parts.length || parts.length === 1 && parts[0].includes('.')) return; // file directly in cwd
  const dir = path.join(cwd, parts[0]); // absolute, so a later cwd change doesn't skew grouping
  s.pathHits.set(dir, (s.pathHits.get(dir) || 0) + 1);
}

function toolDetail(name, input = {}) {
  const d = input.description || input.file_path || input.path || input.pattern || input.url ||
    input.query || input.command || input.prompt || input.skill || '';
  return clip(d, 140);
}

function parseLine(s, line) {
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (o.cwd) s.cwd = o.cwd;
  if (o.gitBranch && o.gitBranch !== 'HEAD') s.branch = o.gitBranch;
  const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
  if (ts) {
    if (!s.firstTs) s.firstTs = ts;
    if (ts > s.lastTs) s.lastTs = ts;
  }

  switch (o.type) {
    case 'ai-title': if (o.aiTitle) s.aiTitle = o.aiTitle; return;
    case 'custom-title': if (o.customTitle) s.customTitle = o.customTitle; return;
    case 'user': return parseUser(s, o, ts);
    case 'attachment': {
      // messages you send while Claude is mid-task are folded in as queued_command attachments
      const a = o.attachment;
      if (!o.isSidechain && a && a.type === 'queued_command' && a.commandMode === 'prompt' &&
          a.origin && a.origin.kind === 'human' && typeof a.prompt === 'string' && a.prompt.trim()) {
        recordPrompt(s, a.prompt.trim(), ts);
      }
      return;
    }
    case 'assistant': return parseAssistant(s, o, ts);
  }
}

function parseUser(s, o, ts) {
  if (o.isSidechain || o.isMeta) return;
  const c = o.message && o.message.content;
  let text = '';
  let toolResult = false;
  let toolError = false;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text') text += (text ? '\n' : '') + b.text;
      else if (b.type === 'tool_result') { toolResult = true; if (b.is_error) toolError = true; }
    }
  }
  if (toolResult && !text) {
    s.phase = 'result';
    if (toolError && s.lastTool) pushTimeline(s, { kind: 'error', text: `${s.lastTool.name} failed`, ts });
    return;
  }
  text = text.trim();
  if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) {
    if (text.startsWith('[Request interrupted')) { s.phase = 'stopped'; pushTimeline(s, { kind: 'error', text: 'Interrupted', ts }); }
    return;
  }
  recordPrompt(s, text, ts);
}

function recordPrompt(s, text, ts) {
  s.prompts++;
  if (!s.firstPrompt) s.firstPrompt = text;
  s.lastPrompt = text;
  s.lastPromptTs = ts;
  s.promptLog.push({ ts, text: clip(text, 400) });
  const bucket = day(s, ts);
  if (bucket) bucket.prompts++;
  s.notice = '';
  s.phase = 'prompted';
  pushTimeline(s, { kind: 'you', text: clip(text, 280), ts });
}

function parseAssistant(s, o, ts) {
  const m = o.message || {};
  if (o.isSidechain) return; // subagent chatter; the main loop is still waiting on its Agent tool call
  const synthetic = m.model === '<synthetic>';
  if (m.model && !synthetic) s.model = m.model;
  const bucket = day(s, ts);
  if (m.usage && m.usage.output_tokens) {
    s.outTokens += m.usage.output_tokens;
    if (bucket) bucket.tokens += m.usage.output_tokens;
  }

  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === 'text' && b.text && b.text.trim()) {
      if (synthetic) { s.notice = clip(b.text, 200); pushTimeline(s, { kind: 'error', text: s.notice, ts }); }
      else { s.lastReply = b.text.trim(); pushTimeline(s, { kind: 'claude', text: clip(b.text, 280), ts }); }
      if (!m.stop_reason) s.phase = 'replying';
    } else if (b.type === 'tool_use') {
      s.tools++;
      s.lastTool = { name: String(b.name).replace(/^mcp__.+?__/, ''), detail: toolDetail(b.name, b.input), ts };
      s.phase = 'tool';
      const inp = b.input || {};
      if (bucket) {
        bucket.tools++;
        if (FILE_EDIT_TOOLS.has(b.name) && (inp.file_path || inp.notebook_path)) bucket.files.add(inp.file_path || inp.notebook_path);
      }
      for (const k of ['file_path', 'path', 'notebook_path']) notePath(s, inp[k]);
      if (typeof inp.command === 'string' && s.cwd) {
        const esc = s.cwd.replace(/[\\/]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const mm of inp.command.matchAll(new RegExp(esc + '[\\\\/]([^\\\\/"\'\\s]+)', 'gi'))) notePath(s, path.join(s.cwd, mm[1], 'x'));
      }
      pushTimeline(s, { kind: 'tool', name: s.lastTool.name, text: s.lastTool.detail, ts });
    }
  }
  if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence' || m.stop_reason === 'max_tokens') s.phase = 'done';
  else if (m.stop_reason === 'tool_use') s.phase = 'tool';
}

function readNew(s, size) {
  const fd = fs.openSync(s.file, 'r');
  try {
    const CHUNK = 8 * 1024 * 1024;
    let pos = s.offset;
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      pos += n;
      const data = s.rest.length ? Buffer.concat([s.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0, i;
      while ((i = data.indexOf(10, start)) !== -1) {
        if (i > start) parseLine(s, data.toString('utf8', start, i));
        start = i + 1;
      }
      s.rest = Buffer.from(data.subarray(start));
    }
    s.offset = pos;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- scanners

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function scanTranscripts() {
  for (const proj of safeReaddir(PROJECTS_DIR)) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, proj.name);
    for (const f of safeReaddir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const id = f.name.slice(0, -6);
      const file = path.join(dir, f.name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      let s = sessions.get(id);
      if (!s || s.file !== file || st.size < s.offset) { s = newSession(id, file); sessions.set(id, s); }
      s.mtime = st.mtimeMs;
      if (st.size > s.offset) {
        try { readNew(s, st.size); } catch (e) { /* file busy; retry next scan */ }
      }
    }
  }
}

const metaCache = new Map(); // file -> { mtime, data }
function scanDesktopMeta() {
  const meta = new Map();
  const deleted = new Set();
  const walk = (dir, depth) => {
    for (const e of safeReaddir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      if (e.name.startsWith('deleted_')) { deleted.add(e.name.slice(8)); continue; }
      if (!e.name.startsWith('local_') || !e.name.endsWith('.json')) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      let c = metaCache.get(p);
      if (!c || c.mtime !== st.mtimeMs) {
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          c = {
            mtime: st.mtimeMs,
            data: {
              localId: j.sessionId, cliId: j.cliSessionId, title: j.title, archived: !!j.isArchived,
              starred: !!j.isStarred, error: j.error || '', errorAt: j.errorAt || 0, model: j.model || '',
            },
          };
          metaCache.set(p, c);
        } catch { continue; }
      }
      if (c.data.cliId) meta.set(c.data.cliId, c.data);
    }
  };
  walk(DESKTOP_DIR, 0);
  desktopMeta = meta;
  deletedIds = deleted;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function scanLive() {
  const live = new Map();
  for (const e of safeReaddir(LIVE_DIR)) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, e.name), 'utf8'));
      if (j.sessionId && j.pid && pidAlive(j.pid)) {
        live.set(j.sessionId, { pid: j.pid, status: j.status || '', updatedAt: j.statusUpdatedAt || j.updatedAt || 0, entrypoint: j.entrypoint || '' });
      }
    } catch { /* partially written; next scan */ }
  }
  liveProcs = live;
}

// ---------------------------------------------------------------- derived view

function projectOf(s) {
  const base = s.cwd ? path.basename(s.cwd.replace(/[\\/]+$/, '')) || s.cwd : 'Unknown folder';
  let top = null, total = 0;
  for (const [dir, n] of s.pathHits) { total += n; if (!top || n > top.n) top = { dir, n }; }
  if (top && top.n >= 3 && top.n / total >= 0.5) return { name: path.basename(top.dir), path: top.dir };
  return { name: base, path: s.cwd };
}

function statusOf(s, live, meta, now) {
  const busy = live ? live.status === 'busy' : (now - s.mtime < ACTIVE_WINDOW_MS && s.phase && s.phase !== 'done' && s.phase !== 'stopped');
  if (busy) return 'working';
  // an error only counts while it's the latest thing in the session and still recent
  if (meta && meta.error && meta.errorAt >= s.lastTs - 60_000 && now - meta.errorAt < 86400_000) return 'error';
  if (live && live.status && live.status !== 'idle') return 'attention';
  if (live) return 'your-turn';
  if (s.phase === 'done') return 'finished';
  if (s.phase) return 'stopped';
  return 'idle';
}

const STATUS_LABEL = {
  working: 'Working', attention: 'Needs you', 'your-turn': 'Your turn', error: 'Error',
  finished: 'Finished', stopped: 'Stopped', idle: 'Idle',
};

function buildView(now = Date.now()) {
  const out = [];
  for (const s of sessions.values()) {
    if (deletedIds.has(s.id)) continue;
    if (samePath(s.cwd, BRIEF_CWD) || (s.cwd && s.cwd.toLowerCase().startsWith(BRIEF_CWD.toLowerCase()))) continue;
    if (!s.prompts && !s.tools) continue;
    const meta = desktopMeta.get(s.id);
    const live = liveProcs.get(s.id);
    const status = statusOf(s, live, meta, now);
    const proj = projectOf(s);
    out.push({
      id: s.id,
      localId: meta ? meta.localId : '',
      title: (meta && meta.title) || s.customTitle || s.aiTitle || clip(s.firstPrompt, 70) || 'Untitled session',
      project: proj.name, projectPath: proj.path, cwd: s.cwd, branch: s.branch,
      status, statusLabel: live && status === 'attention' ? `Needs you (${live.status})` : STATUS_LABEL[status],
      live: !!live,
      source: live && live.entrypoint ? live.entrypoint : (meta ? 'claude-desktop' : 'cli'),
      model: s.model || (meta && meta.model) || '',
      firstPrompt: clip(s.firstPrompt, 240),
      lastPrompt: clip(s.lastPrompt, 320),
      lastReply: clip(s.lastReply, 600),
      lastTool: s.lastTool,
      error: status === 'error' ? clip(meta.error, 200) : '',
      notice: s.notice || (meta && meta.error && meta.errorAt >= s.lastTs - 60_000 ? clip(meta.error, 200) : ''),
      prompts: s.prompts, tools: s.tools, outTokens: s.outTokens,
      firstTs: s.firstTs, lastTs: Math.max(s.lastTs, status === 'working' ? s.mtime : 0),
      starred: !!(meta && meta.starred), archived: !!(meta && meta.archived),
      timeline: s.timeline.slice(-14),
    });
  }
  const rank = { working: 0, attention: 1, error: 2, 'your-turn': 3, finished: 4, stopped: 5, idle: 6 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.lastTs - a.lastTs));
  return out;
}

// ---------------------------------------------------------------- history (yesterday / week / month) + your decisions

let decisions = {}; // cliSessionId -> { state: 'done' | 'drop' | 'keep', at }
try { decisions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).decisions || {}; } catch { /* first run */ }

function saveDecisions() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ decisions }, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function buildHistory(from, to) {
  const view = new Map(buildView().map((v) => [v.id, v]));
  const fromKey = dayKey(from);
  const toKey = dayKey(to - 1);

  const perDay = new Map();
  for (let t = from; t < to; t += 86400_000) perDay.set(dayKey(t), { prompts: 0, tools: 0, sessions: 0 });
  perDay.set(toKey, perDay.get(toKey) || { prompts: 0, tools: 0, sessions: 0 }); // DST-safe last day

  const totals = { sessions: 0, projects: 0, prompts: 0, tools: 0, files: 0, tokens: 0 };
  const allFiles = new Set();
  const projects = new Set();
  const items = [];

  for (const s of sessions.values()) {
    const v = view.get(s.id);
    if (!v) continue;
    let tools = 0, tokens = 0, prompts = 0, firstTs = 0, lastTs = 0;
    const files = new Set();
    for (const [k, b] of s.days) {
      if (k < fromKey || k > toKey) continue;
      prompts += b.prompts; tools += b.tools; tokens += b.tokens;
      b.files.forEach((f) => files.add(f));
      if (!firstTs || b.firstTs < firstTs) firstTs = b.firstTs;
      if (b.lastTs > lastTs) lastTs = b.lastTs;
      const d = perDay.get(k);
      if (d) { d.prompts += b.prompts; d.tools += b.tools; d.sessions++; }
    }
    if (!prompts && !tools) continue;

    const asks = s.promptLog.filter((p) => p.ts >= from && p.ts < to);
    const decision = decisions[s.id] || null;
    let hint = 'Claude finished its last reply';
    if (v.status === 'working') hint = 'Claude is still working on this';
    else if (v.status === 'error' || v.notice) hint = 'Stopped on an error';
    else if (v.status === 'stopped') hint = 'Left mid-task';
    else if (v.status === 'attention') hint = 'Waiting for your input';
    else if (/\?\s*$/.test(s.lastReply || '')) hint = 'Claude asked you a question';

    files.forEach((f) => allFiles.add(f));
    projects.add(v.projectPath || v.project);
    totals.sessions++; totals.prompts += prompts; totals.tools += tools; totals.tokens += tokens;

    items.push({
      id: v.id, localId: v.localId, title: v.title, project: v.project, projectPath: v.projectPath,
      status: v.status, statusLabel: v.statusLabel, hint,
      asks: asks.slice(-10), askCount: asks.length, tools, tokens,
      files: [...files].map((f) => ({ path: f, name: path.basename(f) })).slice(0, 30), fileCount: files.size,
      firstTs, lastTs, lastReply: v.lastReply,
      decision, changedSinceDecision: !!(decision && v.lastTs > decision.at + 5000),
    });
  }
  totals.files = allFiles.size;
  totals.projects = projects.size;
  items.sort((a, b) => b.lastTs - a.lastTs);
  const days = [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, d]) => ({ day: k, ...d }));
  return { from, to, totals, days, items };
}

// ---------------------------------------------------------------- notifications

function notifyTransitions(view) {
  const events = [];
  for (const v of view) {
    const s = sessions.get(v.id);
    if (!s) continue;
    if (!firstScanDone || !s.status) { s.status = v.status; continue; }
    if (v.status === s.status) { s.pendingStatus = ''; s.pendingCount = 0; continue; }
    // require the new status to hold for two scans so brief gaps between tool calls don't fire
    if (s.pendingStatus !== v.status) { s.pendingStatus = v.status; s.pendingCount = 1; continue; }
    if (++s.pendingCount < 2) continue;
    const prev = s.status;
    s.status = v.status;
    s.pendingStatus = '';
    let ev = null;
    if (v.status === 'error') ev = { kind: 'error', title: `Error — ${v.title}`, body: v.error || 'Session hit an error' };
    else if (v.status === 'attention') ev = { kind: 'attention', title: `Needs your input — ${v.title}`, body: v.lastTool ? `${v.lastTool.name}: ${v.lastTool.detail}` : v.statusLabel };
    else if (prev === 'working' && (v.status === 'your-turn' || v.status === 'finished')) ev = { kind: 'done', title: `Claude finished — ${v.title}`, body: clip(v.lastReply, 180) || 'Turn complete' };
    else if (v.status === 'working' && prev !== 'working') ev = { kind: 'start', title: `Working — ${v.title}`, body: clip(v.lastPrompt, 180), quiet: true };
    if (ev) { ev.id = v.id; ev.project = v.project; ev.ts = Date.now(); events.push(ev); }
  }
  for (const ev of events) {
    broadcast('notify', ev);
    if (!ev.quiet) toast(ev.title, ev.body);
  }
}

let toastQueue = Promise.resolve();
function toast(title, body) {
  if (!IS_WIN || !toastsEnabled) return;
  const ps = `
$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:PULSE_T)) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:PULSE_B)) > $null
$n = [Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  toastQueue = toastQueue.then(() => new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      env: { ...process.env, PULSE_T: clip(title, 120), PULSE_B: clip(body, 240) }, windowsHide: true, stdio: 'ignore',
    });
    p.on('exit', resolve);
    p.on('error', resolve);
  }));
}

// ---------------------------------------------------------------- "Brief me" — ask Claude for a cross-project update

function findClaudeCli() {
  const versions = safeReaddir(CLI_DIR)
    .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
    });
  for (const v of versions) {
    const exe = path.join(CLI_DIR, v, IS_WIN ? 'claude.exe' : 'claude');
    if (fs.existsSync(exe)) return exe;
  }
  return 'claude'; // fall back to PATH
}

let briefRunning = false;
function sendText(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function statusBriefPrompt() {
  const cutoff = Date.now() - 14 * 86400_000;
  const view = buildView().filter((v) => !v.archived && v.lastTs >= cutoff).slice(0, 25);
  if (!view.length) return null;
  const digest = view.map((v, i) => [
    `### ${i + 1}. ${v.title}`,
    `project: ${v.project} | status: ${v.statusLabel} | last activity: ${new Date(v.lastTs).toISOString()}`,
    v.firstPrompt && `original ask: ${v.firstPrompt}`,
    v.lastPrompt && v.lastPrompt !== v.firstPrompt && `latest ask: ${v.lastPrompt}`,
    v.lastTool && `last action: ${v.lastTool.name} — ${v.lastTool.detail}`,
    v.lastReply && `Claude's latest message: ${v.lastReply}`,
    v.error && `error: ${v.error}`,
  ].filter(Boolean).join('\n')).join('\n\n');

  return `You are a concise project assistant. Below is a live digest of the user's Claude Code sessions (now: ${new Date().toISOString()}).
Write a short status update grouped by project. For each project give: where it stands (1 line), anything waiting on the user or blocked, and the single best next step.
Finish with a "Do next" line naming the most important thing overall. Use plain markdown bullets, no preamble, under 250 words. Do not use any tools.

${digest}`;
}

function periodReviewPrompt(from, to, label) {
  const h = buildHistory(from, to);
  if (!h.items.length) return null;
  const decisionLabel = { done: 'user marked DONE', drop: 'user marked DROPPED', keep: 'user is KEEPING it open' };
  const digest = h.items.slice(0, 30).map((it, i) => [
    `### ${i + 1}. ${it.title}`,
    `project: ${it.project} | ${it.askCount} requests, ${it.tools} tool calls, ${it.fileCount} files changed in this period | state: ${it.hint}` +
      (it.decision ? ` | ${decisionLabel[it.decision.state]}` : ''),
    `requests: ${it.asks.map((a) => clip(a.text, 200)).join(' || ')}`,
    it.fileCount && `files changed: ${it.files.slice(0, 12).map((f) => f.name).join(', ')}`,
    it.lastReply && `Claude's latest message: ${clip(it.lastReply, 400)}`,
  ].filter(Boolean).join('\n')).join('\n\n');

  return `You are a concise project assistant reviewing what the user did in Claude Code ${label} (${new Date(from).toDateString()} to ${new Date(to - 1).toDateString()}).
Totals: ${h.totals.sessions} sessions across ${h.totals.projects} projects, ${h.totals.prompts} requests, ${h.totals.files} files changed.
Write the review in three markdown sections:
## Done
What actually got accomplished, grouped by project, one bullet each.
## Unfinished
Each loose end, with a clear recommendation: **Finish** (and the concrete next step) or **Drop** (and why). Respect the user's own Done/Dropped marks.
## Focus
One line: the most valuable thing to do next.
No preamble, under 350 words. Do not use any tools.

${digest}`;
}

function runBrief(res, url) {
  if (briefRunning) { res.writeHead(409, { 'Content-Type': 'text/plain' }); return res.end('A brief is already running.'); }
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  let prompt;
  if (from && to > from) {
    prompt = periodReviewPrompt(from, to, clip(url.searchParams.get('label') || 'in this period', 40));
    if (!prompt) return sendText(res, 'No Claude Code activity in this period.');
  } else {
    prompt = statusBriefPrompt();
    if (!prompt) return sendText(res, 'No Claude Code activity in the last 14 days.');
  }

  fs.mkdirSync(BRIEF_CWD, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k.startsWith('CLAUDE_CODE_')) delete env[k];

  briefRunning = true;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  const child = spawn(findClaudeCli(), ['-p', '--model', 'haiku', '--max-turns', '1', '--output-format', 'text'], {
    cwd: BRIEF_CWD, env, windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 180_000);
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; res.write(d); });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (e) => { stderr += e.message; });
  child.on('close', (code) => {
    clearTimeout(timer);
    briefRunning = false;
    if (/not logged in|\/login/i.test(stdout + stderr)) {
      res.write(`\n\n**One-time setup needed:** Pulse runs Claude Code in the background, which needs its own sign-in. ` +
        `Open a terminal and run:\n\n\`"${findClaudeCli()}" /login\`\n\nThen click Brief me again.`);
    } else if (code !== 0 && !stdout) {
      res.write(`\n[Brief failed${code != null ? ` (exit ${code})` : ''}] ${clip(stderr, 400)}`);
    }
    res.end();
  });
  res.on('close', () => { if (child.exitCode == null) child.kill(); });
  child.stdin.end(prompt);
}

// ---------------------------------------------------------------- HTTP + SSE

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function snapshot() {
  return { now: Date.now(), toasts: toastsEnabled, sessions: buildView() };
}

function tick() {
  try {
    scanLive();
    scanDesktopMeta();
    scanTranscripts();
    const snap = snapshot();
    notifyTransitions(snap.sessions);
    firstScanDone = true;
    const json = JSON.stringify(snap.sessions) + snap.toasts;
    if (json !== lastSnapshotJson) {
      lastSnapshotJson = json;
      broadcast('state', snap);
    }
  } catch (e) {
    console.error('[pulse] scan failed:', e.message);
  } finally {
    setTimeout(tick, SCAN_MS);
  }
}

// ---------------------------------------------------------------- optional cloud sync (Supabase)

let cloudConfig = null;
function loadCloudConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CLOUD_CONFIG_FILE, 'utf8'));
    if (c && c.supabaseUrl && c.pulseToken) return { supabaseUrl: c.supabaseUrl.replace(/\/+$/, ''), pulseToken: c.pulseToken };
  } catch { /* cloud sync is optional; absence is normal */ }
  return null;
}

async function cloudFetch(path, init = {}) {
  const c = cloudConfig;
  if (!c) return null;
  const res = await fetch(`${c.supabaseUrl}/functions/v1/pulse-api/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.pulseToken}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`cloud ${path} -> HTTP ${res.status}: ${clip(await res.text().catch(() => ''), 200)}`);
  return res;
}

// Only for session ids actually being upserted this cycle (`ids`) — day_stats.session_id has
// a foreign key to sessions.id, so a day-row for a session buildView() filtered out (deleted,
// sidechain, etc.) would violate it and fail the whole cloud upsert.
function flattenDays(ids) {
  const out = [];
  for (const s of sessions.values()) {
    if (!ids.has(s.id)) continue;
    for (const [day, b] of s.days) {
      if (!b.prompts && !b.tools) continue;
      out.push({ sessionId: s.id, day, prompts: b.prompts, tools: b.tools, tokens: b.tokens, files: [...b.files], firstTs: b.firstTs, lastTs: b.lastTs });
    }
  }
  return out;
}

let cloudSyncing = false;
async function cloudSync() {
  if (!cloudConfig || cloudSyncing) return;
  cloudSyncing = true;
  try {
    const view = buildView();
    if (view.length) await cloudFetch('ingest', { method: 'POST', body: JSON.stringify({ host: HOST_NAME, sessions: view, days: flattenDays(new Set(view.map((v) => v.id))) }) });
  } catch (e) {
    console.error('[pulse] cloud sync failed:', e.message);
  } finally {
    cloudSyncing = false;
    setTimeout(cloudSync, CLOUD_SYNC_MS);
  }
}

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const server = http.createServer((req, res) => {
  if (!allowedHosts.has(req.headers.host)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && (url.pathname === '/pulse.css' || url.pathname === '/cloud.html')) {
    const type = url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, url.pathname.slice(1))).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...snapshot(), cloud: !!cloudConfig }));
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const toParam = url.searchParams.get('to');
    const to = toParam !== null && Number.isFinite(Number(toParam)) ? Number(toParam) : Date.now();
    const fromParam = url.searchParams.get('from');
    const from = fromParam !== null && Number.isFinite(Number(fromParam)) ? Number(fromParam) : to - 7 * 86400_000;
    if (to <= from || to - from > 400 * 86400_000) { res.writeHead(400); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(buildHistory(from, to)));
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  // state-changing endpoints require a custom header so other websites can't trigger them
  if (req.method === 'POST' && req.headers['x-pulse'] === '1') {
    if (url.pathname === '/api/brief') return runBrief(res, url);
    if (url.pathname === '/api/decision') {
      const id = url.searchParams.get('id') || '';
      const state = url.searchParams.get('state');
      if (!sessions.has(id) || !['done', 'drop', 'keep', 'clear'].includes(state)) { res.writeHead(400); return res.end(); }
      if (state === 'clear') delete decisions[id];
      else decisions[id] = { state, at: Date.now() };
      saveDecisions();
      broadcast('decision', { id, decision: decisions[id] || null });
      if (cloudConfig) cloudFetch(`decision?id=${encodeURIComponent(id)}&state=${state}`, { method: 'POST' }).catch((e) => console.error('[pulse] cloud decision failed:', e.message));
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/api/toasts') {
      toastsEnabled = url.searchParams.get('on') === '1';
      lastSnapshotJson = '';
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/api/test-toast') {
      toast('Claude Pulse', 'Notifications are working.');
      res.writeHead(204);
      return res.end();
    }
  }
  res.writeHead(404);
  res.end();
});

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20_000);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`[pulse] already running on http://localhost:${PORT}`); process.exit(0); }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pulse] Claude Pulse running at http://localhost:${PORT}`);
  cloudConfig = loadCloudConfig();
  console.log(cloudConfig ? `[pulse] cloud sync enabled -> ${cloudConfig.supabaseUrl}` : '[pulse] cloud sync not configured (pulse-cloud.json not found)');
  tick();
  if (cloudConfig) cloudSync();
});
