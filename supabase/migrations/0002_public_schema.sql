-- PostgREST (used by supabase-js inside the Edge Function) only serves the `public` schema
-- by default, so move everything there with a pulse_ prefix instead of a separate schema.
-- Same lockdown as before: RLS enabled, zero policies, only the service_role key can touch these.

drop trigger if exists events_trim on pulse.events;
drop function if exists pulse.trim_events();

create table public.pulse_sessions (like pulse.sessions including all);
create table public.pulse_day_stats (like pulse.day_stats including all);
create table public.pulse_decisions (like pulse.decisions including all);
create table public.pulse_events (like pulse.events including all);

insert into public.pulse_sessions select * from pulse.sessions;
insert into public.pulse_day_stats select * from pulse.day_stats;
insert into public.pulse_decisions select * from pulse.decisions;
insert into public.pulse_events (session_id, kind, title, body, project, ts)
  select session_id, kind, title, body, project, ts from pulse.events;

alter table public.pulse_day_stats add constraint pulse_day_stats_session_fk
  foreign key (session_id) references public.pulse_sessions(id) on delete cascade;
alter table public.pulse_decisions add constraint pulse_decisions_session_fk
  foreign key (session_id) references public.pulse_sessions(id) on delete cascade;

alter table public.pulse_sessions   enable row level security;
alter table public.pulse_day_stats  enable row level security;
alter table public.pulse_decisions  enable row level security;
alter table public.pulse_events     enable row level security;

create or replace function public.pulse_trim_events() returns trigger as $$
begin
  delete from public.pulse_events where id in (
    select id from public.pulse_events order by ts desc offset 500
  );
  return null;
end;
$$ language plpgsql;

create trigger pulse_events_trim after insert on public.pulse_events
  execute function public.pulse_trim_events();

drop schema pulse cascade;
