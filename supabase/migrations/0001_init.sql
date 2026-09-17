-- Claude Pulse cloud store.
-- Everything lives in its own schema so it never collides with other data in this project.
-- RLS is enabled with NO policies on every table: that means only the service_role key can
-- touch these tables at all. The Edge Function (pulse-api) holds that key server-side and is
-- the only door in — nothing here is reachable with the public anon key, so there is no
-- separate login/password system to manage for a single-user tool.

create schema if not exists pulse;

create table pulse.sessions (
  id            text primary key,        -- Claude Code's own session id (stable across devices if you sync ~/.claude)
  host          text not null default '',-- machine name this was last updated from
  title         text not null default 'Untitled session',
  project       text not null default '',
  project_path  text,
  cwd           text,
  branch        text,
  status        text not null default 'idle',
  status_label  text,
  live          boolean not null default false,
  source        text,
  model         text,
  first_prompt  text,
  last_prompt   text,
  last_reply    text,
  last_tool     jsonb,
  error         text,
  notice        text,
  prompts       int not null default 0,
  tools         int not null default 0,
  out_tokens    bigint not null default 0,
  first_ts      timestamptz,
  last_ts       timestamptz,
  starred       boolean not null default false,
  archived      boolean not null default false,
  timeline      jsonb not null default '[]',
  updated_at    timestamptz not null default now()
);

create table pulse.day_stats (
  session_id text not null references pulse.sessions(id) on delete cascade,
  day        date not null,
  prompts    int not null default 0,
  tools      int not null default 0,
  tokens     bigint not null default 0,
  files      jsonb not null default '[]',   -- array of distinct file paths touched that day
  first_ts   timestamptz,
  last_ts    timestamptz,
  primary key (session_id, day)
);

create table pulse.decisions (
  session_id text primary key references pulse.sessions(id) on delete cascade,
  state      text not null check (state in ('done', 'drop', 'keep')),
  at         timestamptz not null default now()
);

create table pulse.events (
  id         bigint generated always as identity primary key,
  session_id text,
  kind       text not null,   -- 'done' | 'error' | 'attention' | 'start'
  title      text not null,
  body       text,
  project    text,
  ts         timestamptz not null default now()
);

create index sessions_last_ts_idx on pulse.sessions (last_ts desc);
create index day_stats_day_idx on pulse.day_stats (day);
create index events_ts_idx on pulse.events (ts desc);

alter table pulse.sessions   enable row level security;
alter table pulse.day_stats  enable row level security;
alter table pulse.decisions  enable row level security;
alter table pulse.events     enable row level security;
-- Intentionally no policies: PostgREST/anon and authenticated roles get zero access.
-- Only the Edge Function, using the service_role key, can read or write.

-- Keep events from growing forever — the Live feed only ever shows the last ~20.
create or replace function pulse.trim_events() returns trigger as $$
begin
  delete from pulse.events where id in (
    select id from pulse.events order by ts desc offset 500
  );
  return null;
end;
$$ language plpgsql;

create trigger events_trim after insert on pulse.events
  execute function pulse.trim_events();
