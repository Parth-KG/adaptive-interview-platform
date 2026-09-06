'use client';

import Link from 'next/link';
import { AuthGate } from '@/components/ui/AuthGate';
import { PracticeShell } from '@/components/practice/PracticeShell';
import { SKILL_PATHS } from '@/lib/mockData';

export default function SkillPathsPage() {
  return (
    <AuthGate role="individual">
      <SkillPathsPageContent />
    </AuthGate>
  );
}

function SkillPathsPageContent() {
  const featured = SKILL_PATHS.find((p) => p.featured);
  const rest = SKILL_PATHS.filter((p) => !p.featured);

  return (
    <PracticeShell>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight mb-3">Skill paths</h1>
          <p className="text-[var(--color-practice-ink-soft)] max-w-[56ch]">
            Start with our complete DSA foundations path. The other interview
            domains are visible as a preview while their paths are being built.
          </p>
        </div>
        <Link href="/practice"
              className="px-5 py-2.5 rounded-[var(--radius-control)] text-sm font-semibold
                         bg-[var(--color-practice-sunken)]
                         text-[var(--color-practice-accent)]">
          Open skill analytics
        </Link>
      </div>

      {featured && (
        <section className="rounded-[var(--radius-panel)] p-8 mb-6
                            bg-[var(--color-practice-surface)]
                            border border-[var(--color-practice-border)]
                            shadow-[0_4px_20px_rgba(15,23,42,0.05)]">
          <span className="inline-flex px-3 py-1 rounded-full text-xs font-bold mb-4
                           bg-[color-mix(in_srgb,var(--color-practice-pass)_18%,white)]
                           text-[var(--color-practice-pass)]">
            Available now
          </span>
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="flex-1 min-w-[260px]">
              <h2 className="text-3xl font-extrabold mb-2">{featured.name}</h2>
              <p className="text-sm mb-6">
                <span className="text-[var(--color-practice-ink-soft)]">Recommended next: </span>
                <span className="font-semibold text-[var(--color-practice-accent)]">
                  {featured.next}
                </span>
              </p>
              <Progress level={featured.level} done={featured.done} total={featured.total} />
            </div>
            <Link href="/skills/dsa"
              className="px-6 py-3 rounded-full font-semibold text-white
                         bg-[var(--color-practice-accent)] hover:brightness-110 transition">
              Continue learning
            </Link>
          </div>
        </section>
      )}

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {rest.map((p) => {
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          const locked = !!p.locked;
          return (
            <article key={p.id}
              className={`rounded-[var(--radius-card)] p-6
                          bg-[var(--color-practice-surface)]
                          border border-[var(--color-practice-border)] ${
                locked ? 'opacity-70' : 'hover:-translate-y-0.5 transition'
              }`}>
              <div className="flex items-start justify-between mb-5">
                <span className="w-11 h-11 rounded-[var(--radius-control)] grid place-items-center
                                 bg-[var(--color-practice-sunken)]
                                 text-[var(--color-practice-accent)] text-xs font-bold">
                  {p.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="px-2.5 py-1 rounded-full text-xs font-medium
                                 bg-[var(--color-practice-sunken)]
                                 text-[var(--color-practice-ink-soft)]">
                  {locked ? '🔒' : `Level ${p.level}`}
                </span>
              </div>

              <h3 className="text-lg font-bold leading-snug mb-1">{p.name}</h3>
              <p className="text-sm text-[var(--color-practice-ink-mute)] mb-5">
                {locked ? p.locked : `${p.done}/${p.total} modules completed`}
              </p>

              <div className="text-xs text-[var(--color-practice-ink-soft)] mb-1.5">
                {pct}% mastery
              </div>
              <div className="h-2 rounded-full bg-[var(--color-practice-sunken)]">
                <div className="h-full rounded-full bg-[var(--color-practice-accent)]"
                     style={{ width: `${pct}%` }} />
              </div>
            </article>
          );
        })}
      </div>
    </PracticeShell>
  );
}

function Progress({ level, done, total }: { level: number; done: number; total: number }) {
  const pct = Math.round((done / total) * 100);
  return (
    <>
      <div className="flex justify-between text-sm mb-2">
        <span className="font-semibold">Level {level}</span>
        <span className="text-[var(--color-practice-ink-soft)]">
          {pct}% completed ({done}/{total} modules)
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-[var(--color-practice-sunken)] max-w-[520px]">
        <div className="h-full rounded-full bg-[var(--color-practice-accent)]"
             style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}
