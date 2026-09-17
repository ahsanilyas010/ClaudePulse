// Claude Pulse cloud API — the only door into the pulse_* tables (kept in `public` since
// PostgREST only serves that schema by default; RLS with no policies still locks them to
// the service_role key used inside this function).
//
// Auth model: a single shared secret (PULSE_TOKEN, set as a function secret), checked
// against `Authorization: Bearer <token>` on every request. There is no per-user login —
// this is a personal, single-owner tool, so a long random token stands in for one. The
// service_role key used against Postgres never leaves this function (Supabase injects it
// automatically as SUPABASE_SERVICE_ROLE_KEY for every Edge Function).
//
// Routes (path is whatever comes after /pulse-api/):
//   POST /ingest    body: { host, sessions: [...], days: [...] }   — local server pushes its snapshot
//   POST /decision   ?id=&state=done|drop|keep|clear                — same as the local /api/decision
//   GET  /state                                                     — mirrors local GET /api/state
//   GET  /history?from=&to=                                         — mirrors local GET /api/history
//
// Deploy: supabase functions deploy pulse-api
// Secret: supabase secrets set PULSE_TOKEN=<random>

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PULSE_TOKEN = Deno.env.get('PULSE_TOKEN') ?? '';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

const STATUS_RANK: Record<string, number> = { working: 0, attention: 1, error: 2, 'your-turn': 3, finished: 4, stopped: 5, idle: 6 };

// This function always runs in UTC (Deno Deploy), but day_stats.day is stored as each
// machine's own LOCAL calendar day. Deriving day boundaries from UTC here would drift by
// the caller's UTC offset, so dayKeyUTC is only a fallback for a caller that didn't send
// explicit fromDay/toDay — the real path is the client (which knows its own timezone)
// passing those strings directly.
function dayKeyUTC(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function addDaysUTC(day: string, n: number) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function getState() {
  const { data, error } = await db.from('pulse_sessions').select('*').order('last_ts', { ascending: false });
  if (error) throw error;
  const sessions = (data ?? [])
    .filter((s) => !s.archived)
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || +new Date(b.last_ts) - +new Date(a.last_ts))
    .map(toClientSession);
  return { now: Date.now(), toasts: true, sessions };
}

function toClientSession(s: any) {
  return {
    id: s.id, localId: '', title: s.title, project: s.project, projectPath: s.project_path, cwd: s.cwd, branch: s.branch,
    status: s.status, statusLabel: s.status_label, live: s.live, source: s.source, model: s.model,
    firstPrompt: s.first_prompt, lastPrompt: s.last_prompt, lastReply: s.last_reply, lastTool: s.last_tool,
    error: s.error, notice: s.notice, prompts: s.prompts, tools: s.tools, outTokens: s.out_tokens,
    firstTs: s.first_ts ? +new Date(s.first_ts) : 0, lastTs: s.last_ts ? +new Date(s.last_ts) : 0,
    starred: s.starred, archived: s.archived, timeline: s.timeline ?? [], host: s.host,
  };
}

async function getHistory(fromDay: string, toDay: string, fromMs: number, toMs: number) {
  const [{ data: days, error: e1 }, { data: sessions, error: e2 }, { data: decisions, error: e3 }] = await Promise.all([
    db.from('pulse_day_stats').select('*').gte('day', fromDay).lt('day', toDay),
    db.from('pulse_sessions').select('*'),
    db.from('pulse_decisions').select('*'),
  ]);
  if (e1) throw e1; if (e2) throw e2; if (e3) throw e3;

  const decisionBySession = new Map((decisions ?? []).map((d) => [d.session_id, d]));
  const sessionById = new Map((sessions ?? []).map((s) => [s.id, s]));
  const bySession = new Map<string, any[]>();
  for (const d of days ?? []) {
    if (!bySession.has(d.session_id)) bySession.set(d.session_id, []);
    bySession.get(d.session_id)!.push(d);
  }

  const perDay = new Map<string, { day: string; prompts: number; tools: number; sessions: number }>();
  for (let d = fromDay; d < toDay; d = addDaysUTC(d, 1)) perDay.set(d, { day: d, prompts: 0, tools: 0, sessions: 0 });

  const totals = { sessions: 0, projects: 0, prompts: 0, tools: 0, files: 0, tokens: 0 };
  const allFiles = new Set<string>(); const projects = new Set<string>();
  const items: any[] = [];

  for (const [sid, rows] of bySession) {
    const s = sessionById.get(sid);
    if (!s) continue;
    let prompts = 0, tools = 0, tokens = 0, firstTs = 0, lastTs = 0;
    const files = new Set<string>();
    for (const r of rows) {
      prompts += r.prompts; tools += r.tools; tokens += r.tokens;
      for (const f of r.files ?? []) files.add(f);
      const first = +new Date(r.first_ts), last = +new Date(r.last_ts);
      if (!firstTs || first < firstTs) firstTs = first;
      if (last > lastTs) lastTs = last;
      const d = perDay.get(r.day);
      if (d) { d.prompts += r.prompts; d.tools += r.tools; d.sessions++; }
    }
    if (!prompts && !tools) continue;
    files.forEach((f) => allFiles.add(f));
    projects.add(s.project_path || s.project);
    totals.sessions++; totals.prompts += prompts; totals.tools += tools; totals.tokens += tokens;

    const decision = decisionBySession.get(sid) ? { state: decisionBySession.get(sid).state, at: +new Date(decisionBySession.get(sid).at) } : null;
    let hint = 'Claude finished its last reply';
    if (s.status === 'working') hint = 'Claude is still working on this';
    else if (s.status === 'error' || s.notice) hint = 'Stopped on an error';
    else if (s.status === 'stopped') hint = 'Left mid-task';
    else if (s.status === 'attention') hint = 'Waiting for your input';
    else if (/\?\s*$/.test(s.last_reply || '')) hint = 'Claude asked you a question';

    items.push({
      id: sid, localId: '', title: s.title, project: s.project, projectPath: s.project_path,
      status: s.status, statusLabel: s.status_label, hint,
      asks: [], askCount: prompts, tools, tokens,
      files: [...files].map((f) => ({ path: f, name: f.split(/[\\/]/).pop() })).slice(0, 30), fileCount: files.size,
      firstTs, lastTs, lastReply: s.last_reply,
      decision, changedSinceDecision: !!(decision && lastTs > decision.at + 5000),
    });
  }
  totals.files = allFiles.size; totals.projects = projects.size;
  items.sort((a, b) => b.lastTs - a.lastTs);
  return { from: fromMs, to: toMs, totals, days: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)), items };
}

async function ingest(body: any) {
  const host: string = body.host || 'unknown';
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const days = Array.isArray(body.days) ? body.days : [];

  if (sessions.length) {
    const rows = sessions.map((s: any) => ({
      id: s.id, host, title: s.title, project: s.project, project_path: s.projectPath, cwd: s.cwd, branch: s.branch,
      status: s.status, status_label: s.statusLabel, live: !!s.live, source: s.source, model: s.model,
      first_prompt: s.firstPrompt, last_prompt: s.lastPrompt, last_reply: s.lastReply, last_tool: s.lastTool,
      error: s.error, notice: s.notice, prompts: s.prompts, tools: s.tools, out_tokens: s.outTokens,
      first_ts: s.firstTs ? new Date(s.firstTs).toISOString() : null, last_ts: s.lastTs ? new Date(s.lastTs).toISOString() : null,
      starred: !!s.starred, archived: !!s.archived, timeline: s.timeline ?? [], updated_at: new Date().toISOString(),
    }));
    const { error } = await db.from('pulse_sessions').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  }
  if (days.length) {
    const rows = days.map((d: any) => ({
      session_id: d.sessionId, day: d.day, prompts: d.prompts, tools: d.tools, tokens: d.tokens,
      files: d.files ?? [], first_ts: new Date(d.firstTs).toISOString(), last_ts: new Date(d.lastTs).toISOString(),
    }));
    const { error } = await db.from('pulse_day_stats').upsert(rows, { onConflict: 'session_id,day' });
    if (error) throw error;
  }
  return { ok: true, sessions: sessions.length, days: days.length };
}

async function setDecision(id: string, state: string) {
  if (state === 'clear') {
    const { error } = await db.from('pulse_decisions').delete().eq('session_id', id);
    if (error) throw error;
    return null;
  }
  if (!['done', 'drop', 'keep'].includes(state)) throw new Error('bad state');
  const row = { session_id: id, state, at: new Date().toISOString() };
  const { error } = await db.from('pulse_decisions').upsert(row, { onConflict: 'session_id' });
  if (error) throw error;
  return row;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  }
  if (!PULSE_TOKEN || req.headers.get('authorization') !== `Bearer ${PULSE_TOKEN}`) return json({ error: 'unauthorized' }, 401);

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/pulse-api\/?/, '');

  try {
    if (req.method === 'GET' && route === 'state') return json(await getState());
    if (req.method === 'GET' && route === 'history') {
      const toParam = url.searchParams.get('to');
      const to = toParam !== null && Number.isFinite(Number(toParam)) ? Number(toParam) : Date.now();
      const fromParam = url.searchParams.get('from');
      const from = fromParam !== null && Number.isFinite(Number(fromParam)) ? Number(fromParam) : to - 7 * 86_400_000;
      // fromDay/toDay (local calendar-day strings) are the real query bounds — see dayKeyUTC's comment.
      const fromDay = url.searchParams.get('fromDay') || dayKeyUTC(new Date(from));
      const toDay = url.searchParams.get('toDay') || dayKeyUTC(new Date(to));
      return json(await getHistory(fromDay, toDay, from, to));
    }
    if (req.method === 'POST' && route === 'ingest') return json(await ingest(await req.json()));
    if (req.method === 'POST' && route === 'decision') {
      const id = url.searchParams.get('id') || '';
      const state = url.searchParams.get('state') || '';
      return json({ decision: await setDecision(id, state) });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
