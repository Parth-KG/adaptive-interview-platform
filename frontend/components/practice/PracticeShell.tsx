'use client';

import { usePlayer } from '@/hooks/usePlayer';
import { SignOutButton } from '@/components/ui/AuthGate';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The chrome every practice screen sits inside: top nav with the XP and gem
 * counters, and a left rail carrying the profile card, skill nav and upgrade
 * button. Lifted straight from the discovery, results and leaderboard photos,
 * which all share it exactly.
 *
 * Presentational. Numbers come in as props so nothing here fetches.
 */

export interface PracticeUser {
  name: string;
  track: string;
  level: number;
  xp: number;
  streak: number;
  gems: number;
}

const NAV = [
  { href: '/practice', label: 'Practice' },
  { href: '/skills', label: 'Skills' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/profile', label: 'Profile' },
];

const RAIL = [
  { href: '/practice', label: 'Dashboard', icon: GridIcon },
  { href: '/skills',   label: 'Skill paths', icon: NodesIcon },
  { href: '/job-panels', label: 'Job interviews', icon: BriefcaseIcon },
  { href: '/practice/behavioural', label: 'Behavioural', icon: TargetIcon },
  { href: '/practice/technical', label: 'Technical', icon: CodeIcon },
  { href: '/practice/case-study', label: 'Case study', icon: ChartIcon },
  { href: '/practice/system-design', label: 'System design', icon: NodesIcon },
  { href: '/practice/hr-round', label: 'HR round', icon: PeopleIcon },
  { href: '/analytics', label: 'Analytics', icon: ChartIcon },
  { href: '/settings', label: 'Settings', icon: CogIcon },
];

export function PracticeShell({
  user: providedUser, children,
}: { user?: PracticeUser; children: React.ReactNode }) {
  // Loaded here rather than by each page: every practice screen shows the same
  // XP, streak and gem counters, and twelve pages each fetching their own copy
  // is twelve chances for them to disagree.
  const { user: livePlayer } = usePlayer({ touchDaily: true });
  const user = providedUser ?? livePlayer;
  const pathname = usePathname();

  const isRailActive = (href: string) => {
    if (pathname === href) return true;

    // Configure and results belong to the dashboard journey, while category
    // pages have their own, more specific rail entries.
    if (href === '/practice') {
      return pathname.startsWith('/practice/configure') ||
             pathname.startsWith('/practice/results');
    }

    return pathname.startsWith(`${href}/`);
  };

  return (
    <div className="min-h-screen bg-[var(--color-practice-bg)] text-[var(--color-practice-ink)]">
      <header className="sticky top-0 z-20 bg-[var(--color-practice-surface)]
                         border-b border-[var(--color-practice-border)]">
        <div className="mx-auto max-w-[1280px] px-6 h-16 flex items-center gap-10">
          <Link href="/" className="text-xl font-extrabold tracking-tight
                                    text-[var(--color-practice-deep)]">
            InterviewPro
          </Link>

          <nav className="hidden md:flex items-center gap-7">
            {NAV.map((n) => {
              const on = pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`text-sm transition ${
                    on
                      ? 'font-semibold text-[var(--color-practice-accent)] border-b-2 border-[var(--color-practice-accent)] pb-1'
                      : 'text-[var(--color-practice-ink-soft)] hover:text-[var(--color-practice-ink)]'
                  }`}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Link href="/notifications" aria-label="Notifications"
                  className="w-9 h-9 rounded-full grid place-items-center
                             text-[var(--color-practice-ink-soft)]
                             hover:bg-[var(--color-practice-sunken)]">
              <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0"/>
              </svg>
            </Link>
            <Counter icon={<StarIcon />} value={user.streak} tone="xp" label="day streak" />
            <Counter icon={<GemIcon />} value={user.gems} tone="gem" label="gems" />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1280px] px-6 py-8 flex gap-8">
        <aside className="hidden lg:flex w-[232px] shrink-0 flex-col gap-1">
          <div className="rounded-[var(--radius-card)] bg-[var(--color-practice-sunken)] p-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-[var(--color-practice-accent)]
                              grid place-items-center text-white font-bold">
                {user.name.charAt(0)}
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{user.name}</div>
                <div className="text-xs text-[var(--color-practice-accent)]">
                  Level {user.level} · {user.xp.toLocaleString()} XP
                </div>
              </div>
            </div>
          </div>

          {RAIL.map((r) => {
            const on = isRailActive(r.href);
            const Icon = r.icon;
            return (
              <Link
                key={r.label}
                href={r.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-control)]
                            text-sm transition ${
                  on
                    ? 'bg-[var(--color-practice-accent)] text-white font-semibold'
                    : 'text-[var(--color-practice-ink-soft)] hover:bg-[var(--color-practice-sunken)]'
                }`}
              >
                <Icon />
                {r.label}
              </Link>
            );
          })}

          <button className="mt-6 w-full py-3 rounded-[var(--radius-control)] font-semibold
                             text-sm text-white bg-[var(--color-practice-deep)]
                             hover:brightness-110 transition">
            Upgrade to Pro
          </button>

          <div className="mt-3 flex justify-center">
            <SignOutButton />
          </div>
        </aside>

        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}

function Counter({ icon, value, tone, label }:
  { icon: React.ReactNode; value: number; tone: 'xp' | 'gem'; label: string }) {
  const color = tone === 'xp' ? 'var(--color-practice-xp)' : 'var(--color-practice-gem)';
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full
                    bg-[var(--color-practice-sunken)]">
      <span style={{ color }} aria-hidden="true">{icon}</span>
      <span className="font-bold text-sm">{value}</span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

/* icons */
const s = 'w-[18px] h-[18px]';
const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const };
function GridIcon()   { return <svg className={s} viewBox="0 0 24 24" {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>; }
function TargetIcon() { return <svg className={s} viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>; }
function CodeIcon()   { return <svg className={s} viewBox="0 0 24 24" {...p}><path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/></svg>; }
function ChartIcon()  { return <svg className={s} viewBox="0 0 24 24" {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>; }
function NodesIcon()  { return <svg className={s} viewBox="0 0 24 24" {...p}><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6a3 3 0 0 1 3 3v6"/></svg>; }
function CogIcon()    { return <svg className={s} viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>; }
function PeopleIcon() { return <svg className={s} viewBox="0 0 24 24" {...p}><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0-2-5.2M21 20a5 5 0 0 0-4-4.9"/></svg>; }
function BriefcaseIcon() { return <svg className={s} viewBox="0 0 24 24" {...p}><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/></svg>; }
function StarIcon()   { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 6.5 7 .9-5 4.9 1.2 7L12 18l-6.2 3.3L7 14.3l-5-4.9 7-.9z"/></svg>; }
function GemIcon()    { return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12l4 6-10 12L2 9z"/></svg>; }
