'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '@/components/ui/AuthGate';
import { PracticeShell } from '@/components/practice/PracticeShell';
import { usePlayer } from '@/hooks/usePlayer';
import {
  levelProgress, loadLeagueStanding, subscribeToCohort,
  type LeaderboardRow, type LeagueStanding,
} from '@/lib/gamification';

/**
 * The weekly league board.
 *
 * Ranked on XP earned this week inside a cohort of at most thirty, not on
 * lifetime totals. That is the whole design: a lifetime board is won once and
 * then read by nobody, whereas a weekly one resets the question every Monday
 * and puts a new player within reach of the top on their first day.
 */
export default function LeaderboardPage() {
  return (
    <AuthGate role="individual">
      <LeaderboardPageContent />
    </AuthGate>
  );
}

function LeaderboardPageContent() {
  const { profile, signedIn, loading: playerLoading } = usePlayer();
  const [standing, setStanding] = useState<LeagueStanding | null>(null);
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [find, setFind] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await loadLeagueStanding();
        if (!active) return;
        setStanding(data);
        setRows(data?.rows ?? []);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  // Live: somebody finishing an interview moves the board under you.
  useEffect(() => {
    if (!standing?.cohortId) return;
    return subscribeToCohort(standing.cohortId, setRows);
  }, [standing?.cohortId]);

  const visible = rows.filter(row => !find.trim() || row.display_name.toLowerCase().includes(find.toLowerCase()));
  // Read your own numbers from the cohort row, and fall back to the same
  // string the row projection uses. The card said "You" while the row directly
  // beneath it said "Anonymous learner" for the same blank display name.
  const me = rows.find(row => row.you);
  const progress = levelProgress(profile.total_xp);

  const promoteCount = standing?.tier.promote_count ?? 0;
  const demoteFrom = rows.length - (standing?.tier.demote_count ?? 0);
  const zoneOf = (rank: number) =>
    rank <= promoteCount ? 'promote' : rank > demoteFrom ? 'demote' : 'hold';

  return (
    <PracticeShell>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="mb-3 text-4xl font-extrabold tracking-tight text-[var(--color-practice-deep)]">
            {standing ? `${standing.tier.name} league` : 'Leaderboard'}
          </h1>
          <p className="max-w-[52ch] text-[var(--color-practice-ink-soft)]">
            {standing
              ? `Top ${promoteCount} move up. Bottom ${standing.tier.demote_count} move down. Ranked on XP earned this week.`
              : 'Finish an interview to join this week’s league.'}
          </p>
        </div>
        {standing?.seasonEndsOn && (
          <div className="shrink-0 rounded-[var(--radius-card)] bg-[var(--color-practice-sunken)] px-5 py-3 text-center">
            <p className="text-xs text-[var(--color-practice-ink-mute)]">Week ends</p>
            <p className="font-bold">{new Date(standing.seasonEndsOn).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
          </div>
        )}
      </div>

      {error && <Card tone="warn"><p className="text-sm">{error}</p></Card>}

      {!playerLoading && !signedIn && (
        <Card><p className="text-sm text-[var(--color-practice-ink-soft)]">Sign in to join the league and start earning XP.</p></Card>
      )}

      <section className="mb-6 rounded-[var(--radius-panel)] bg-[var(--color-practice-sunken)] p-7">
        <div className="mb-6 flex items-center gap-5">
          <div className="relative">
            <div className="grid h-20 w-20 place-items-center rounded-full bg-[var(--color-practice-accent)] text-2xl font-bold text-white">
              {(profile.display_name?.trim() || 'Anonymous learner').charAt(0).toUpperCase()}
            </div>
            <span className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full bg-[var(--color-practice-xp)] text-xs font-bold text-white ring-4 ring-[var(--color-practice-sunken)]">
              {progress.level}
            </span>
          </div>
          <div>
            <h2 className="text-2xl font-extrabold">{profile.display_name?.trim() || 'Anonymous learner'}</h2>
            <p className="font-medium text-[var(--color-practice-accent)]">
              {profile.is_premium ? 'Premium member' : 'Free plan'}
            </p>
          </div>
        </div>

        <div className="mb-6 flex flex-wrap gap-3">
          <Stat label="This week" value={`${(me?.weekly_xp ?? 0).toLocaleString()} XP`} tone="xp" />
          <Stat label="League rank" value={me ? `#${me.rank}` : '—'} />
          <Stat label="Streak" value={`${profile.streak_days} day${profile.streak_days === 1 ? '' : 's'}`} tone="xp" />
          <Stat label="Gems" value={profile.gems.toLocaleString()} tone="gem" />
        </div>

        <div className="mb-2 flex justify-between text-xs text-[var(--color-practice-ink-soft)]">
          <span>Level {progress.level} · {profile.total_xp.toLocaleString()} XP total</span>
          <span>{progress.toNext.toLocaleString()} XP to level {progress.level + 1}</span>
        </div>
        <div className="h-2.5 rounded-full bg-[var(--color-practice-surface)]">
          <div className="h-full rounded-full bg-[var(--color-practice-accent)]" style={{ width: `${progress.percent}%` }} />
        </div>
      </section>

      <section className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-practice-border)] bg-[var(--color-practice-surface)]">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--color-practice-border)] p-6">
          <h2 className="text-xl font-bold">
            Live rankings
            {rows.length > 0 && <span className="ml-2 text-sm font-normal text-[var(--color-practice-ink-mute)]">{rows.length} in your cohort</span>}
          </h2>
          <label htmlFor="league-search" className="sr-only">Find a player in your league</label>
          <input
            id="league-search"
            value={find}
            onChange={event => setFind(event.target.value)}
            placeholder="Find a player…"
            className="h-10 w-48 rounded-[var(--radius-control)] border border-[var(--color-practice-border)] bg-[var(--color-practice-sunken)] px-3 text-sm outline-none"
          />
        </div>

        {loading && <p className="p-6 text-sm text-[var(--color-practice-ink-mute)]">Loading the board…</p>}
        {!loading && !rows.length && (
          <p className="p-8 text-sm text-[var(--color-practice-ink-soft)]">
            Nobody has earned XP in this cohort yet. Finish an interview and you will be first.
          </p>
        )}

        {visible.map(row => {
          const zone = zoneOf(row.rank);
          return (
            <div
              key={row.user_id}
              className={`flex items-center gap-4 border-b border-[var(--color-practice-border)] p-4 last:border-0 ${row.you ? 'bg-[var(--color-practice-sunken)]' : ''}`}
            >
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold ${
                  zone === 'promote' ? 'bg-[var(--color-practice-pass)] text-white'
                  : zone === 'demote' ? 'bg-[#e4b3b3] text-[#7a1f1f]'
                  : 'bg-[var(--color-practice-sunken)]'}`}
              >
                {row.rank}
                <span className="sr-only">
                  {zone === 'promote' ? ' — promotion zone'
                    : zone === 'demote' ? ' — demotion zone'
                    : ' — holding position'}
                </span>
              </span>
              {zone !== 'hold' && (
                <span
                  aria-hidden="true"
                  className={`shrink-0 text-xs font-bold ${zone === 'promote' ? 'text-[var(--color-practice-pass)]' : 'text-[#a33]'}`}
                >
                  {zone === 'promote' ? '▲' : '▼'}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {row.display_name}
                  {row.you && <span className="ml-2 text-xs text-[var(--color-practice-accent)]">you</span>}
                  {row.is_premium && <span className="ml-2 rounded bg-[var(--color-practice-sunken)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-practice-gem)]">PRO</span>}
                </p>
                <p className="text-xs text-[var(--color-practice-ink-mute)]">Level {row.level}</p>
              </div>
              <span className="shrink-0 font-bold">{row.weekly_xp.toLocaleString()} XP</span>
            </div>
          );
        })}

        {!loading && rows.length > 0 && !visible.length && (
          <p className="p-6 text-sm text-[var(--color-practice-ink-soft)]">No player matches that search.</p>
        )}
      </section>
    </PracticeShell>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'xp' | 'gem' }) {
  const color = tone === 'xp' ? 'var(--color-practice-xp)' : tone === 'gem' ? 'var(--color-practice-gem)' : 'inherit';
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-practice-surface)] px-4 py-3">
      <p className="text-xs text-[var(--color-practice-ink-mute)]">{label}</p>
      <p className="font-bold" style={{ color }}>{value}</p>
    </div>
  );
}

function Card({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <div className={`mb-5 rounded-[var(--radius-card)] p-5 ${tone === 'warn' ? 'bg-[#fdf3e3] text-[#6b5713]' : 'bg-[var(--color-practice-sunken)]'}`}>
      {children}
    </div>
  );
}
