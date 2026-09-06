'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '@/components/ui/AuthGate';
import { PracticeShell } from '@/components/practice/PracticeShell';
import { usePlayer } from '@/hooks/usePlayer';
import {
  BILLING_ENABLED, GEM_SINKS, PREMIUM_BENEFITS, levelProgress, loadGemPrices, loadTrophies,
  type GemSpend, type Trophy,
} from '@/lib/gamification';

export default function ProfilePage() {
  return (
    <AuthGate role="individual">
      <ProfilePageContent />
    </AuthGate>
  );
}

function ProfilePageContent() {
  const { profile, signedIn, loading } = usePlayer();
  const [trophies, setTrophies] = useState<Trophy[]>([]);
  const [prices, setPrices] = useState<Partial<Record<GemSpend, number>>>({});

  useEffect(() => {
    let active = true;
    loadTrophies()
      .then(rows => { if (active) setTrophies(rows); })
      .catch(() => { /* signed out, or the tables are not installed yet */ });
    loadGemPrices()
      .then(rows => { if (active) setPrices(rows); })
      .catch(() => { /* prices render as a dash rather than a wrong number */ });
    return () => { active = false; };
  }, []);

  const progress = levelProgress(profile.total_xp);
  const earned = trophies.filter(trophy => trophy.earned_at);
  const locked = trophies.filter(trophy => !trophy.earned_at);
  const name = profile.display_name?.trim() || 'You';

  return (
    <PracticeShell>
      <div className="mb-8 flex flex-wrap items-start gap-6">
        <div className="relative">
          <div className="grid h-28 w-28 place-items-center rounded-full bg-[var(--color-practice-accent)] text-4xl font-extrabold text-white">
            {name.charAt(0).toUpperCase()}
          </div>
          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-[var(--color-practice-deep)] px-3 py-1 text-xs font-bold text-white">
            Lvl {progress.level}
          </span>
        </div>

        <div className="min-w-[220px] flex-1">
          <h1 className="text-4xl font-extrabold tracking-tight">{name}</h1>
          <p className="mt-1 text-xl font-bold text-[var(--color-practice-accent)]">
            {profile.is_premium ? 'Premium member' : 'Free plan'}
          </p>
          <p className="mt-2 text-sm text-[var(--color-practice-ink-soft)]">
            {profile.total_xp.toLocaleString()} XP total · longest streak {profile.longest_streak} day{profile.longest_streak === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {!loading && !signedIn && (
        <div className="mb-6 rounded-[var(--radius-card)] bg-[var(--color-practice-sunken)] p-5 text-sm text-[var(--color-practice-ink-soft)]">
          Sign in to start earning XP, gems and trophies.
        </div>
      )}

      <div className="mb-6 grid gap-5 lg:grid-cols-[1fr_320px]">
        <section className="rounded-[var(--radius-panel)] border border-[var(--color-practice-border)] bg-[var(--color-practice-surface)] p-7">
          <h2 className="mb-5 text-xl font-bold">Progress</h2>
          <div className="mb-2 flex justify-between text-sm">
            <span>Level {progress.level}</span>
            <span className="text-[var(--color-practice-ink-mute)]">{progress.into.toLocaleString()} / {progress.needed.toLocaleString()} XP</span>
          </div>
          <div className="h-3 rounded-full bg-[var(--color-practice-sunken)]">
            <div className="h-full rounded-full bg-[var(--color-practice-accent)]" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="mt-3 text-xs text-[var(--color-practice-ink-mute)]">
            {progress.toNext.toLocaleString()} XP to level {progress.level + 1}.
          </p>

          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric label="Streak" value={`${profile.streak_days}d`} tone="xp" />
            <Metric label="Gems" value={profile.gems.toLocaleString()} tone="gem" />
            <Metric label="Trophies" value={`${earned.length}/${trophies.length}`} />
            <Metric label="Total XP" value={profile.total_xp.toLocaleString()} />
          </div>
        </section>

        <section className="rounded-[var(--radius-panel)] border border-[var(--color-practice-border)] bg-[var(--color-practice-surface)] p-6">
          <h2 className="font-bold">Spend gems</h2>
          <p className="mt-1 text-xs text-[var(--color-practice-ink-mute)]">You have {profile.gems.toLocaleString()}.</p>
          <ul className="mt-4 space-y-3">
            {Object.entries(GEM_SINKS).map(([key, item]) => (
              <li key={key} className="flex items-start justify-between gap-3 border-b border-[var(--color-practice-border)] pb-3 last:border-0">
                <span className="min-w-0">
                  <b className="block text-sm">{item.label}</b>
                  <span className="text-xs leading-5 text-[var(--color-practice-ink-mute)]">{item.blurb}</span>
                </span>
                <span className="shrink-0 font-bold" style={{ color: 'var(--color-practice-gem)' }}>{prices[key as GemSpend] ?? '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mb-6 rounded-[var(--radius-panel)] border border-[var(--color-practice-border)] bg-[var(--color-practice-surface)] p-7">
        <h2 className="mb-1 text-xl font-bold">Trophies</h2>
        <p className="mb-6 text-sm text-[var(--color-practice-ink-soft)]">
          Six to earn. Deliberately few — a wall of participation badges is worth less than a short list you had to work for.
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {earned.map(trophy => <TrophyCard key={trophy.code} trophy={trophy} earned />)}
          {locked.map(trophy => <TrophyCard key={trophy.code} trophy={trophy} />)}
          {!trophies.length && <p className="text-sm text-[var(--color-practice-ink-mute)]">Trophies load once you are signed in.</p>}
        </div>
      </section>

      {!profile.is_premium && (
        <section className="rounded-[var(--radius-panel)] bg-[var(--color-practice-sunken)] p-7">
          <h2 className="text-xl font-bold">Premium</h2>
          <ul className="mt-4 space-y-2">
            {PREMIUM_BENEFITS.map(benefit => (
              <li key={benefit} className="flex gap-2.5 text-sm text-[var(--color-practice-ink-soft)]">
                <span className="shrink-0 text-[var(--color-practice-pass)]">✓</span>{benefit}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-[var(--color-practice-ink-mute)]">
            Premium changes how fast you earn and how much of each report you see. It never buys XP —
            the leaderboard stays a measure of practice, not spending.
          </p>
          {!BILLING_ENABLED && (
            /* An honest label beats a button that does nothing. Payments are
               not wired yet; the entitlement plumbing behind them is. */
            <p className="mt-4 inline-flex rounded-full bg-[var(--color-practice-surface)] px-4 py-2 text-xs font-semibold text-[var(--color-practice-ink-soft)]">
              Coming soon — payments are not live yet.
            </p>
          )}
        </section>
      )}
    </PracticeShell>
  );
}

function TrophyCard({ trophy, earned = false }: { trophy: Trophy; earned?: boolean }) {
  return (
    <div className={`rounded-[var(--radius-card)] border p-5 ${earned ? 'border-[var(--color-practice-xp)] bg-[var(--color-practice-sunken)]' : 'border-[var(--color-practice-border)] opacity-70'}`}>
      <div className="flex items-start justify-between gap-2">
        <b className="text-sm">{trophy.name}</b>
        <span className="shrink-0 text-lg">{earned ? '🏆' : '🔒'}</span>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-[var(--color-practice-ink-soft)]">
        {earned ? trophy.description : trophy.hint}
      </p>
      <p className="mt-2 text-[11px] font-semibold text-[var(--color-practice-ink-mute)]">
        {earned && trophy.earned_at
          ? `Earned ${new Date(trophy.earned_at).toLocaleDateString()}`
          : `+${trophy.xp_reward} XP · +${trophy.gem_reward} gems`}
      </p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'xp' | 'gem' }) {
  const color = tone === 'xp' ? 'var(--color-practice-xp)' : tone === 'gem' ? 'var(--color-practice-gem)' : 'inherit';
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-practice-sunken)] p-4">
      <p className="text-xs text-[var(--color-practice-ink-mute)]">{label}</p>
      <p className="mt-1 text-xl font-extrabold" style={{ color }}>{value}</p>
    </div>
  );
}
