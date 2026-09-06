'use client';

/**
 * The one and only rendering of a finished interview report.
 *
 * Lifted out of `components/console/EnterpriseReports.tsx`, where it was the
 * private `ReportDetail`. Three surfaces now show a report - the stored
 * enterprise report page, a candidate's published-interview result, and the
 * throwaway report at the end of a test run - and the requirement is that they
 * look identical, because they *are* the same evaluation. Keeping one component
 * is the only version of that which stays true after the next design change.
 *
 * It renders a plain object, not a database row. The ephemeral test report
 * never touches Supabase, so anything that fetches would rule it out as a
 * caller; `record` is assembled in memory there and read from a row here.
 */

import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { ConsoleCard } from '@/components/console/ConsoleShell';
import type { ReportRecord, TranscriptEntry } from '@/lib/reports';

export const percent = (value: number | null | undefined) =>
  (typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 100)) : '—');

/** "en-US" is a locale code, not a language. Show the language. */
function languageLabel(code: string | undefined): string {
  if (!code) return '—';
  try {
    const base = code.split('-')[0];
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(base) ?? code;
  } catch { return code; }
}
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase() || 'CA';

export function InterviewReportView({ record }: { record: ReportRecord }) {
  const report = record.report;
  const competencies = Array.isArray(report?.competencies) ? report.competencies : [];
  // Plot only what was actually assessed. seed_agent_states() pre-creates a 0.0
  // placeholder for every declared competency, so an interview that ended early
  // drew a polygon collapsed to the centre - a candidate who ran out of time
  // looked identical to one who failed everything.
  const measured = competencies.filter(item => item.assessed !== false);
  const unmeasured = competencies.length - measured.length;
  const skills = measured.map(item => ({
    name: item.name,
    score: Math.round(Math.max(0, Math.min(1, item.score)) * 100),
    threshold: Math.round(Math.max(0, Math.min(1, item.threshold ?? 0.7)) * 100),
    covered: item.covered,
  }));
  const agents = Array.isArray(report?.agents) ? report.agents : [];
  const started = Date.parse(report?.started_at ?? '');
  const finished = Date.parse(report?.finished_at ?? '');
  const duration = Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, Math.round((finished - started) / 60000))
    : null;

  return (
    <>
      <ConsoleCard className="p-7">
        <div className="grid items-center gap-7 lg:grid-cols-[1fr_1.15fr]">
          <div className="flex items-center gap-5">
            <span className="grid size-28 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#dce6f3] to-[#acbdd2] font-serif text-3xl font-bold">
              {initials(record.candidate_name)}
            </span>
            <div>
              <h1 className="font-serif text-4xl font-bold">{record.candidate_name || 'Unnamed candidate'}</h1>
              <p className="mt-1 text-lg text-[#555a62]">{record.role_name || record.panel_name}<br />Candidate</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <StatusPillLocal tone={record.band === 'Strong' ? 'green'
                  : record.band === 'Solid' ? 'blue' : 'amber'}>
                  {(record.recommendation || 'Needs Review').toUpperCase()}
                </StatusPillLocal>
                <span className="rounded-md bg-[#eff1f3] px-3 py-1.5 text-xs font-semibold">{record.candidate_ref}</span>
              </div>
            </div>
          </div>
          <div className="rounded-xl bg-[#eceef0] p-6">
            <div className="grid items-center gap-5 sm:grid-cols-[130px_1fr]">
              <div className="border-r border-[#cbd0d5] pr-5 text-center">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#5f646c]">Overall Score</p>
                <strong className="mt-2 block font-serif text-5xl">
                  {percent(record.overall_score)}<small className="text-lg font-normal">/100</small>
                </strong>
              </div>
              <div className="space-y-4">
                {agents.map(agent => {
                  const score = agent.score ?? 0;
                  return (
                    <div key={agent.agent_id} className="grid grid-cols-[140px_1fr_40px] items-center gap-3 text-sm">
                      <span className="truncate">
                        <b>{agent.name}</b>
                        <small className="block text-[10px] text-[#737880]">
                          {agent.weight === undefined ? 'Legacy scoring' : `${Math.round(agent.weight * 100)}% weight`}
                          {' · '}{Math.round(agent.satisfaction * 100)}% assessment confidence
                        </small>
                      </span>
                      <div className="h-2 rounded bg-white">
                        <div className="h-2 rounded bg-black" style={{ width: `${Math.round(score * 100)}%` }} />
                      </div>
                      <b>{Math.round(score * 100)}</b>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </ConsoleCard>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_350px]">
        <div className="space-y-5">
          <ConsoleCard className="p-7">
            <h2 className="font-serif text-2xl font-bold">Executive Summary</h2>
            <p className="mt-5 text-[15px] leading-7 text-[#50555d]">{record.executive_summary}</p>
          </ConsoleCard>
          <div className="grid gap-5 md:grid-cols-2">
            <EvidenceCard title="Key Strengths" items={record.strengths} strength />
            <EvidenceCard title="Growth Areas" items={record.growth_areas} />
          </div>
          <ConsoleCard className="p-7">
            <h2 className="font-serif text-xl font-bold">Interview details</h2>
            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
              {([
                ['Duration', duration === null ? '—' : `${duration} minutes`],
                ['Questions', `${report?.totals?.questions_answered ?? 0} answered`],
                ['Completion', record.completed ? 'Completed' : 'Ended early'],
                ['Language', languageLabel(report?.language)],
              ] as [string, string][]).map(item => (
                <div key={item[0]} className="flex justify-between border-b border-[#e6e8eb] pb-3">
                  <dt className="text-[#747981]">{item[0]}</dt>
                  <dd className="font-semibold">{item[1]}</dd>
                </div>
              ))}
            </dl>
          </ConsoleCard>
        </div>
        <ConsoleCard className="p-7">
          <h2 className="text-center font-serif text-2xl font-bold">Skill Matrix</h2>
          <div className="mt-10"><SkillRadar skills={skills} /></div>
          {unmeasured > 0 && (
            <p className="mt-6 text-center text-xs text-[#777c84]">
              {unmeasured} further {unmeasured === 1 ? 'competency was' : 'competencies were'} configured
              but never assessed, so {unmeasured === 1 ? 'it is' : 'they are'} not plotted.
            </p>
          )}
        </ConsoleCard>
      </div>

      <TranscriptSection turns={report.transcript} />
    </>
  );
}

/**
 * The conversation, as it happened.
 *
 * Every report has carried a full transcript since reports existed - it was
 * simply never rendered, so a finished interview could not be read back. Both
 * halves are shown: the question each interviewer put, and the answer given to
 * it, in order, including the opening exchange with the host.
 *
 * The question text is the one the backend selected from the knowledge base.
 * The interviewer rephrases it in its own voice when speaking, so this is a
 * faithful record of what was asked, not a word-for-word capture of the audio.
 */
function TranscriptSection({ turns }: { turns: TranscriptEntry[] }) {
  if (!turns.length) return null;
  return (
    <ConsoleCard className="mt-5 p-7">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-serif text-2xl font-bold">Transcript</h2>
        <span className="text-sm text-[#747981]">{turns.length} turns</span>
      </div>
      <p className="mt-2 text-sm text-[#747981]">
        Questions are shown as they were selected for the interviewer, who rephrases them
        naturally when speaking.
      </p>
      <ol className="mt-6 space-y-5">
        {turns.map(turn => {
          const isAgent = turn.speaker === 'agent';
          const who = isAgent ? turn.agent_name : 'Candidate';
          return (
            <li key={turn.turn} className="flex gap-4">
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  isAgent ? 'bg-[#e2ecfb] text-[#1d4a86]' : 'bg-[#eceef1] text-[#50555d]'
                }`}
              >
                {initials(who)}
              </div>
              <div className="min-w-0 flex-1 border-b border-[#e6e8eb] pb-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{who}</span>
                  {isAgent && <span className="text-xs text-[#747981]">asked</span>}
                  {typeof turn.question_score === 'number' && (
                    <StatusPillLocal tone={turn.question_score >= 0.7 ? 'green' : turn.question_score >= 0.4 ? 'blue' : 'amber'}>
                      {percent(turn.question_score)}%
                    </StatusPillLocal>
                  )}
                  {turn.flags.map(flag => (
                    <span key={flag} className="rounded-md bg-[#fbf0dd] px-2 py-0.5 text-xs font-semibold text-[#7a5310]">
                      {flag.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[15px] leading-7 text-[#50555d]">{turn.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </ConsoleCard>
  );
}

// Imported lazily-by-copy rather than from ConsoleShell so this component can be
// mounted inside the candidate-facing interview window, which does not pull in
// the enterprise console shell.
function StatusPillLocal({ tone, children }: { tone: 'green' | 'blue' | 'amber'; children: React.ReactNode }) {
  const palette = {
    green: 'bg-[#e4f4e8] text-[#256134]',
    blue: 'bg-[#e2ecfb] text-[#1d4a86]',
    amber: 'bg-[#fbf0dd] text-[#7a5310]',
  }[tone];
  return <span className={`inline-flex rounded-md px-3 py-1.5 text-xs font-semibold ${palette}`}>{children}</span>;
}

function EvidenceCard({ title, items, strength = false }: { title: string; items: string[]; strength?: boolean }) {
  return (
    <ConsoleCard className={`${strength ? 'border-t-[3px] border-t-black' : ''} p-6`}>
      <h2 className="text-xs font-semibold uppercase tracking-[.16em] text-[#555a62]">{title}</h2>
      <ul className="mt-5 space-y-4">
        {items.map(item => (
          <li key={item} className="flex gap-3 text-sm leading-6">
            {strength ? <CheckCircle2 size={18} className="mt-0.5 shrink-0" /> : <ArrowRight size={18} className="mt-0.5 shrink-0" />}
            {item}
          </li>
        ))}
      </ul>
    </ConsoleCard>
  );
}

interface Skill { name: string; score: number; threshold: number; covered: boolean }

/**
 * The skill matrix.
 *
 * A radar needs at least three axes to enclose an area - with one competency the
 * old version drew a single point (nothing visible) and with two a degenerate
 * line. Under three, this falls back to bars, which read better anyway.
 *
 * Both forms show the configured threshold, because a score is only meaningful
 * against the bar it had to clear: 0.65 and 0.75 look identical without it.
 */
function SkillRadar({ skills }: { skills: Skill[] }) {
  if (!skills.length) {
    return (
      <p className="text-center text-sm text-[#777c84]">
        No competency was assessed in this interview.
      </p>
    );
  }
  if (skills.length < 3) return <SkillBars skills={skills} />;

  const R = 82;
  const C = 150;
  const at = (index: number, radius: number) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / skills.length;
    return [C + Math.cos(angle) * radius, C + Math.sin(angle) * radius] as const;
  };
  const poly = skills.map((s, i) => at(i, (s.score / 100) * R).join(',')).join(' ');
  const thresholdPoly = skills.map((s, i) => at(i, (s.threshold / 100) * R).join(',')).join(' ');

  return (
    <div>
      <svg viewBox="0 0 300 300" className="mx-auto w-full max-w-[330px]"
           role="img" aria-label={`Skill matrix: ${skills.map(s => `${s.name} ${s.score} out of 100`).join(', ')}`}>
        {[R, R * 0.72, R * 0.44].map(r => (
          <circle key={r} cx={C} cy={C} r={r} fill="none" stroke="#d9dde2" />
        ))}
        {skills.map((_, i) => {
          const [x, y] = at(i, R);
          return <line key={i} x1={C} y1={C} x2={x} y2={y} stroke="#d9dde2" />;
        })}
        <polygon points={thresholdPoly} fill="none" stroke="#b9772a" strokeWidth="1.5" strokeDasharray="4 3" />
        <polygon points={poly} fill="rgba(17,17,17,.10)" stroke="#111" strokeWidth="2" />
        {skills.map((s, i) => {
          const [x, y] = at(i, (s.score / 100) * R);
          return <circle key={s.name} cx={x} cy={y} r="3.5" fill={s.covered ? '#256134' : '#a4442f'} />;
        })}
        {skills.map((s, i) => {
          const [x, y] = at(i, R + 20);
          const anchor = Math.abs(x - C) < 6 ? 'middle' : x > C ? 'start' : 'end';
          return (
            <text key={s.name} x={x} y={y} textAnchor={anchor} dominantBaseline="middle"
                  fontSize="10.5" fill="#555a62">
              {s.name.length > 18 ? `${s.name.slice(0, 17)}\u2026` : s.name}
            </text>
          );
        })}
      </svg>
      <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-[#5f646c]">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0 w-4 border-t-2 border-[#111]" />Scored</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0 w-4 border-t-2 border-dashed border-[#b9772a]" />Threshold</span>
      </div>
      <SkillChips skills={skills} />
    </div>
  );
}

function SkillBars({ skills }: { skills: Skill[] }) {
  return (
    <div className="mx-auto max-w-[420px] space-y-5">
      {skills.map(s => (
        <div key={s.name}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold">{s.name}</span>
            <span className="tabular-nums text-[#555a62]">{s.score}<small>/100</small></span>
          </div>
          <div className="relative mt-2 h-2.5 rounded-full bg-[#e6e8eb]">
            <div className={`h-full rounded-full ${s.covered ? 'bg-[#256134]' : 'bg-[#a4442f]'}`} style={{ width: `${s.score}%` }} />
            <span className="absolute top-[-3px] h-[16px] w-px bg-[#b9772a]" style={{ left: `${s.threshold}%` }} title={`Threshold ${s.threshold}`} />
          </div>
        </div>
      ))}
      <p className="pt-1 text-center text-[11px] text-[#777c84]">The vertical mark is the configured pass threshold.</p>
    </div>
  );
}

function SkillChips({ skills }: { skills: Skill[] }) {
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {skills.map(s => (
        <span key={s.name}
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                s.covered ? 'border-[#bcd9c4] bg-[#f0f7f2] text-[#256134]'
                          : 'border-[#e2c3bb] bg-[#fbf3f1] text-[#a4442f]'}`}>
          {s.name} · {s.score}<span className="ml-1 font-normal opacity-70">/ {s.threshold}</span>
        </span>
      ))}
    </div>
  );
}

