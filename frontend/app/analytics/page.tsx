'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '@/components/ui/AuthGate';
import { PracticeShell } from '@/components/practice/PracticeShell';
import { ANALYTICS as A } from '@/lib/mockData';

const TONE = {
  accent: 'var(--color-practice-accent)',
  warn:   'var(--color-practice-xp)',
  pass:   'var(--color-practice-pass)',
};

export default function AnalyticsPage() {
  return (
    <AuthGate role="individual">
      <AnalyticsPageContent />
    </AuthGate>
  );
}

function AnalyticsPageContent() {
  // The design pack includes a loading state for this screen, so it gets one.
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), 550); return () => clearTimeout(t); }, []);

  const C = 2 * Math.PI * 54;

  return (
    <PracticeShell>
      <div className="flex flex-wrap items-start justify-between gap-6 mb-8">
        <div className="max-w-[60ch]">
          <div className="text-[11px] font-bold tracking-[0.14em]
                          text-[var(--color-practice-accent)] mb-3">
            SKILL ANALYTICS
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight mb-4">
            Your readiness profile
          </h1>
          <p className="text-[var(--color-practice-ink-soft)]">
            You are trending towards{' '}
            <span className="font-semibold text-[var(--color-practice-pass)]">{A.trending}</span>{' '}
            for {A.towards} roles. {A.focus} is the one holding you back.
          </p>
        </div>
        <button className="px-5 py-2.5 rounded-[var(--radius-control)] text-sm font-semibold
                           bg-[var(--color-practice-sunken)]
                           text-[var(--color-practice-accent)]">
          Export report
        </button>
      </div>

      {!ready ? <Skeleton /> : (
        <>
          <div className="grid gap-5 lg:grid-cols-[320px_1fr] mb-6">
            <section className="rounded-[var(--radius-panel)] p-7 text-center
                                bg-[var(--color-practice-sunken)]">
              <h2 className="text-xl font-extrabold mb-5">Interview score</h2>
              <div className="relative w-[180px] h-[180px] mx-auto">
                <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                  <circle cx="60" cy="60" r="54" fill="none" strokeWidth="12"
                          stroke="var(--color-practice-surface)" />
                  <circle cx="60" cy="60" r="54" fill="none" strokeWidth="12" strokeLinecap="round"
                          stroke="var(--color-practice-accent)"
                          strokeDasharray={C} strokeDashoffset={C * (1 - A.score / 100)} />
                </svg>
                <div className="absolute inset-0 grid place-content-center">
                  <div className="text-4xl font-extrabold">{A.score}</div>
                  <div className="text-xs text-[var(--color-practice-ink-mute)]">/ 100</div>
                </div>
              </div>
              <span className="inline-flex mt-5 px-4 py-2 rounded-full text-sm font-semibold
                               bg-[color-mix(in_srgb,var(--color-practice-pass)_18%,white)]
                               text-[var(--color-practice-pass)]">
                +{A.delta} points this week
              </span>
            </section>

            <section className="rounded-[var(--radius-panel)] p-7
                                bg-[var(--color-practice-surface)]
                                border border-[var(--color-practice-border)]
                                grid gap-8 md:grid-cols-2 items-center">
              <Radar points={A.radar} />
              <div className="space-y-5">
                <h2 className="text-xl font-extrabold">Domain breakdown</h2>
                {A.domains.map((d) => (
                  <div key={d.label}>
                    <div className="flex justify-between text-sm mb-1.5">
                      <span className="font-medium">{d.label}</span>
                      <span className="text-[var(--color-practice-ink-mute)]">{d.value}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--color-practice-sunken)]">
                      <div className="h-full rounded-full"
                           style={{ width: `${d.value}%`, background: TONE[d.tone] }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="rounded-[var(--radius-panel)] p-8
                              bg-[var(--color-practice-sunken)]">
            <h2 className="text-2xl font-extrabold mb-2">Recommended path to level up</h2>
            <p className="text-[var(--color-practice-ink-soft)] mb-7 max-w-[68ch]">
              Getting {A.focus} to 75% would put your overall readiness in the top 10% of
              candidates on this track.
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              {A.recommended.map((r) => (
                <article key={r.title}
                  className={`rounded-[var(--radius-card)] p-5 ${
                    r.locked
                      ? 'border border-dashed border-[var(--color-practice-border)] text-center'
                      : 'bg-[var(--color-practice-surface)] border border-[var(--color-practice-border)]'
                  }`}>
                  {r.locked ? (
                    <>
                      <div className="w-11 h-11 mx-auto rounded-full grid place-items-center mb-3
                                      bg-[var(--color-practice-surface)]">🔒</div>
                      <div className="font-bold text-sm mb-1
                                      text-[var(--color-practice-ink-mute)]">{r.title}</div>
                      <p className="text-xs text-[var(--color-practice-ink-mute)]">{r.blurb}</p>
                    </>
                  ) : (
                    <>
                      <div className="w-11 h-11 rounded-[var(--radius-control)] grid place-items-center
                                      mb-4 text-white bg-[var(--color-practice-accent)]">★</div>
                      <div className="font-bold mb-1.5">{r.title}</div>
                      <p className="text-xs text-[var(--color-practice-ink-soft)] mb-5">{r.blurb}</p>
                      <div className="flex items-center justify-between text-xs
                                      text-[var(--color-practice-ink-mute)] pt-3
                                      border-t border-[var(--color-practice-border)]">
                        <span>{r.minutes} mins</span>
                        <span className="text-[var(--color-practice-accent)] font-bold">→</span>
                      </div>
                    </>
                  )}
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </PracticeShell>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your analytics</span>
      <div className="h-[360px] rounded-[var(--radius-panel)]
                      bg-[var(--color-practice-sunken)] animate-pulse" />
      <div className="h-[360px] rounded-[var(--radius-panel)]
                      bg-[var(--color-practice-sunken)] animate-pulse" />
    </div>
  );
}

function Radar({ points }: { points: { label: string; value: number }[] }) {
  const C = 110, R = 74;
  const pt = (i: number, r: number) => {
    const a = (Math.PI * 2 * i) / points.length - Math.PI / 2;
    return [C + Math.cos(a) * r, C + Math.sin(a) * r] as const;
  };
  const ring = (f: number) => points.map((_, i) => pt(i, R * f).join(',')).join(' ');
  const shape = points.map((p, i) => pt(i, R * p.value).join(',')).join(' ');

  return (
    <svg viewBox="0 0 220 220" className="w-full max-w-[260px] mx-auto" role="img"
         aria-label={points.map((p) => `${p.label} ${Math.round(p.value * 100)}%`).join(', ')}>
      {[0.33, 0.66, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none"
                 stroke="var(--color-practice-border)" />
      ))}
      <polygon points={shape} fill="color-mix(in srgb, var(--color-practice-accent) 18%, transparent)"
               stroke="var(--color-practice-accent)" strokeWidth="2" />
      {points.map((p, i) => {
        const [x, y] = pt(i, R + 20);
        return (
          <text key={p.label} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
                fontSize="9" fill="var(--color-practice-ink-mute)">
            {p.label}
          </text>
        );
      })}
    </svg>
  );
}
