'use client';

import Link from 'next/link';
import { loginHref } from '@/lib/authRoles';

/** The individuals landing page — the marketing front door for the practice
 *  side. Split hero, then the loop it sells: streak, XP, league, trophies. */

const LOOP = [
  { k: '12', l: 'day streak',  tone: 'xp'  },
  { k: '2,450', l: 'XP earned', tone: 'accent' },
  { k: 'Gold', l: 'league',    tone: 'gem' },
  { k: '3', l: 'trophies',     tone: 'accent' },
];

export default function IndividualsLanding() {
  return (
    <div className="min-h-screen bg-[var(--color-practice-bg)] text-[var(--color-practice-ink)]">
      <header className="border-b border-[var(--color-practice-border)]
                         bg-[var(--color-practice-surface)]">
        <div className="mx-auto max-w-[1280px] px-6 h-16 flex items-center gap-10">
          <Link href="/" className="text-xl font-extrabold tracking-tight
                                    text-[var(--color-practice-deep)]">InterviewPro</Link>
          <nav className="hidden md:flex items-center gap-7 text-sm
                          text-[var(--color-practice-ink-soft)]">
            <Link href={loginHref('individual', '/practice')}>Practice</Link>
            <Link href={loginHref('individual', '/skills')}>Skills</Link>
            <Link href={loginHref('individual', '/leaderboard')}>Leaderboard</Link>
          </nav>
          <Link href={loginHref('individual')} className="ml-auto text-sm font-semibold
                                         text-[var(--color-practice-accent)]">Sign in</Link>
        </div>
      </header>

      <section className="mx-auto max-w-[1280px] px-6 py-20 grid gap-14 lg:grid-cols-2 items-center">
        <div>
          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs
                           font-semibold mb-7 bg-[var(--color-practice-sunken)]
                           text-[var(--color-practice-accent)]">
            Practice on your own schedule
          </span>
          <h1 className="text-5xl font-extrabold tracking-tight leading-[1.1] mb-6">
            Master your interviews,<br />one round at a time.
          </h1>
          <p className="text-lg text-[var(--color-practice-ink-soft)] max-w-[52ch] mb-9">
            A structured path to the job you want. Practise with an AI panel, earn XP for
            every round you finish, and build the confidence that only repetition gives you.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href={loginHref('individual')}
                  className="px-7 py-3.5 rounded-[var(--radius-control)] font-semibold text-white
                             bg-[var(--color-practice-accent)] hover:brightness-110 transition">
              Start your journey
            </Link>
            <Link href={loginHref('individual', '/leaderboard')}
                  className="px-7 py-3.5 rounded-[var(--radius-control)] font-semibold
                             bg-[var(--color-practice-surface)]
                             border border-[var(--color-practice-border)]
                             hover:bg-[var(--color-practice-sunken)] transition">
              See the leaderboard
            </Link>
          </div>
        </div>

        <div className="rounded-[var(--radius-panel)] p-8 bg-[var(--color-practice-sunken)]">
          <div className="rounded-[var(--radius-card)] bg-[var(--color-practice-surface)] p-6
                          shadow-[0_8px_28px_rgba(15,23,42,0.08)]">
            <div className="flex items-center gap-3 mb-6">
              <span className="w-11 h-11 rounded-full grid place-items-center text-white
                               font-bold bg-[var(--color-practice-accent)]">A</span>
              <div>
                <div className="font-bold text-sm">Your name</div>
                <div className="text-xs text-[var(--color-practice-accent)]">
                  Level 12 · your track
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {LOOP.map((s) => (
                <div key={s.l} className="rounded-[var(--radius-control)] p-4
                                          bg-[var(--color-practice-bg)]">
                  <div className="text-2xl font-extrabold" style={{
                    color: s.tone === 'xp' ? 'var(--color-practice-xp)'
                         : s.tone === 'gem' ? 'var(--color-practice-gem)'
                         : 'var(--color-practice-accent)' }}>
                    {s.k}
                  </div>
                  <div className="text-xs text-[var(--color-practice-ink-mute)]">{s.l}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-[var(--color-practice-border)]
                          bg-[var(--color-practice-surface)]">
        <div className="mx-auto max-w-[1280px] px-6 py-16">
          <h2 className="text-2xl font-extrabold mb-10">Interviews for what you actually face</h2>
          <div className="grid gap-5 md:grid-cols-3">
            {[
              ['By skill', 'Algorithms, system design, frontend, backend, machine learning, behavioural.'],
              ['By role', 'Software engineer, senior engineer, ML engineer, data analyst.'],
              ['By language', 'Python, TypeScript, Java, Go, C++, SQL — and 18 spoken languages.'],
            ].map(([t, d]) => (
              <div key={t} className="rounded-[var(--radius-card)] p-6
                                      bg-[var(--color-practice-bg)]
                                      border border-[var(--color-practice-border)]">
                <h3 className="font-bold mb-2">{t}</h3>
                <p className="text-sm text-[var(--color-practice-ink-soft)]">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--color-practice-border)] py-10">
        <div className="mx-auto max-w-[1280px] px-6 flex flex-wrap gap-6 items-center
                        justify-between text-sm text-[var(--color-practice-ink-mute)]">
          <span className="font-extrabold text-[var(--color-practice-deep)]">InterviewPro</span>
          <nav className="flex flex-wrap gap-6">
            <Link href={loginHref('individual', '/practice')}>Practice</Link>
            <Link href={loginHref('individual', '/skills')}>Skills</Link>
            <Link href="/enterprise-landing">For enterprises</Link>
          </nav>
          <span>© 2026 InterviewPro</span>
        </div>
      </footer>
    </div>
  );
}
