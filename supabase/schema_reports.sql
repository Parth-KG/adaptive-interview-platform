-- RecruitPro candidate reports. Run after supabase/schema.sql.
-- Idempotent upgrade: safe for databases that already have interview_reports.

create table if not exists public.interview_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  panel_id uuid references public.panels (id) on delete set null,
  candidate_name text not null default '', candidate_ref text not null default '',
  session_id text not null, panel_name text not null default '', role_name text not null default '',
  language text not null default '', overall_score numeric(6,5), band text,
  recommendation text not null default '', executive_summary text not null default '',
  strengths jsonb not null default '[]'::jsonb, growth_areas jsonb not null default '[]'::jsonb,
  completed boolean not null default false, started_at timestamptz, finished_at timestamptz,
  source text not null default 'published',
  report_version integer not null default 1, report jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint interview_reports_score_range check (overall_score is null or overall_score between 0 and 1),
  constraint interview_reports_strengths_array check (jsonb_typeof(strengths) = 'array'),
  constraint interview_reports_growth_array check (jsonb_typeof(growth_areas) = 'array'),
  constraint interview_reports_source_check check (source in ('published', 'self'))
);

-- Upgrade installations using the original minimal report table.
alter table public.interview_reports add column if not exists panel_name text not null default '';
alter table public.interview_reports add column if not exists role_name text not null default '';
alter table public.interview_reports add column if not exists language text not null default '';
alter table public.interview_reports add column if not exists recommendation text not null default '';
alter table public.interview_reports add column if not exists executive_summary text not null default '';
alter table public.interview_reports add column if not exists strengths jsonb not null default '[]'::jsonb;
alter table public.interview_reports add column if not exists growth_areas jsonb not null default '[]'::jsonb;
alter table public.interview_reports add column if not exists started_at timestamptz;
alter table public.interview_reports add column if not exists finished_at timestamptz;
alter table public.interview_reports add column if not exists report_version integer not null default 1;
alter table public.interview_reports add column if not exists updated_at timestamptz not null default now();
alter table public.interview_reports add column if not exists source text not null default 'published';

-- Where a report came from. Rows written by the browser under a signed-in
-- owner are 'self'; rows written by FastAPI for an anonymous candidate on an
-- invite link are 'published'. There is deliberately no 'test' value: a test
-- run of a panel is never stored, so a value for it would only ever be wrong.
-- Existing rows predate the split and are all real candidate interviews, so the
-- 'published' default backfills them correctly.
alter table public.interview_reports drop constraint if exists interview_reports_source_check;
alter table public.interview_reports
  add constraint interview_reports_source_check check (source in ('published', 'self'));

update public.interview_reports
set panel_name = coalesce(nullif(panel_name, ''), report->>'panel_name', ''),
    language = coalesce(nullif(language, ''), report->>'language', ''),
    started_at = coalesce(started_at, nullif(report->>'started_at', '')::timestamptz),
    finished_at = coalesce(finished_at, nullif(report->>'finished_at', '')::timestamptz)
where panel_name = '' or language = '' or started_at is null or finished_at is null;

create unique index if not exists interview_reports_session_uidx on public.interview_reports (user_id, session_id);
create index if not exists interview_reports_user_created_idx on public.interview_reports (user_id, created_at desc);
create index if not exists interview_reports_user_score_idx on public.interview_reports (user_id, overall_score desc nulls last, created_at desc);
create index if not exists interview_reports_user_role_idx on public.interview_reports (user_id, lower(role_name), created_at desc);
create index if not exists interview_reports_candidate_ref_idx on public.interview_reports (user_id, candidate_ref);
create index if not exists interview_reports_panel_idx on public.interview_reports (user_id, panel_id, created_at desc);
create index if not exists interview_reports_user_source_idx on public.interview_reports (user_id, source, created_at desc);

create table if not exists public.interview_report_scores (
  report_id uuid not null references public.interview_reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  competency_name text not null, competency_key text not null,
  score numeric(6,5) not null check (score between 0 and 1),
  threshold numeric(6,5) not null default 0.7 check (threshold between 0 and 1),
  weight numeric(10,5) not null default 1, covered boolean not null default false,
  checked_by jsonb not null default '[]'::jsonb,
  primary key (report_id, competency_key),
  constraint interview_report_scores_checked_by_array check (jsonb_typeof(checked_by) = 'array')
);

create index if not exists interview_report_scores_rank_idx
  on public.interview_report_scores (user_id, competency_key, score desc, report_id);

create or replace function public.normalized_report_key(value text)
returns text language sql immutable parallel safe
as $$ select trim(both '-' from regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', '-', 'g')) $$;

create or replace function public.sync_interview_report_scores()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  delete from public.interview_report_scores where report_id = new.id;
  -- distinct on the KEY, not the name.
  --
  -- Two competency names that normalise to the same key ("System Design" and
  -- "system design", or "API Design" and "API-Design") used to reach a single
  -- INSERT ... ON CONFLICT, which Postgres rejects with 21000 "ON CONFLICT DO
  -- UPDATE command cannot affect row a second time". That aborts the trigger,
  -- and because the trigger fires in the same transaction as the report write,
  -- the candidate's entire report was lost. Nothing upstream constrains the
  -- competency names the scoring model returns, so dedupe here.
  --
  -- Highest score wins, which matches the best-of roll-up in report.py.
  -- Rows that were never assessed are skipped so they cannot pollute rankings.
  insert into public.interview_report_scores
    (report_id, user_id, competency_name, competency_key, score, threshold, weight, covered, checked_by)
  select distinct on (public.normalized_report_key(item->>'name'))
         new.id, new.user_id, item->>'name', public.normalized_report_key(item->>'name'),
         greatest(0, least(1, coalesce((item->>'score')::numeric, 0))),
         greatest(0, least(1, coalesce((item->>'threshold')::numeric, 0.7))),
         coalesce((item->>'weight')::numeric, 1),
         coalesce((item->>'covered')::boolean, false), coalesce(item->'checked_by', '[]'::jsonb)
  from jsonb_array_elements(coalesce(new.report->'competencies', '[]'::jsonb)) item
  where nullif(item->>'name', '') is not null
    and coalesce((item->>'assessed')::boolean, true)
  order by public.normalized_report_key(item->>'name'),
           coalesce((item->>'score')::numeric, 0) desc;
  return new;
end;
$$;

drop trigger if exists interview_reports_sync_scores on public.interview_reports;
create trigger interview_reports_sync_scores after insert or update of report on public.interview_reports
for each row execute function public.sync_interview_report_scores();

drop trigger if exists interview_reports_set_updated_at on public.interview_reports;
create trigger interview_reports_set_updated_at before update on public.interview_reports
for each row execute function public.set_updated_at();

-- Populate normalized scores for rows created before this migration.
-- Restricted to rows that have no score rows yet: the unconditional form
-- rewrote every historical row on every migration run, bumping updated_at for
-- all of them and re-firing the sync trigger across the whole table.
update public.interview_reports r set report = r.report
where not exists (
  select 1 from public.interview_report_scores s where s.report_id = r.id
);

alter table public.interview_reports enable row level security;
alter table public.interview_report_scores enable row level security;

drop policy if exists "reports_select_own" on public.interview_reports;
create policy "reports_select_own" on public.interview_reports for select using (auth.uid() = user_id);
drop policy if exists "reports_insert_own" on public.interview_reports;
create policy "reports_insert_own" on public.interview_reports for insert with check (auth.uid() = user_id);
drop policy if exists "reports_update_own" on public.interview_reports;
create policy "reports_update_own" on public.interview_reports for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "reports_delete_own" on public.interview_reports;
create policy "reports_delete_own" on public.interview_reports for delete using (auth.uid() = user_id);
drop policy if exists "report_scores_select_own" on public.interview_report_scores;
create policy "report_scores_select_own" on public.interview_report_scores for select using (auth.uid() = user_id);

select relname, relrowsecurity as rls_enabled
from pg_class where oid in ('public.interview_reports'::regclass, 'public.interview_report_scores'::regclass)
order by relname;
