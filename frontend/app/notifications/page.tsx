'use client';

import { useState } from 'react';
import { AuthGate } from '@/components/ui/AuthGate';
import { PracticeShell } from '@/components/practice/PracticeShell';
import { NOTIFICATIONS } from '@/lib/mockData';

const ICON = { trophy: '★', result: '📄', league: '▲', streak: '🔥' };
const TINT = {
  trophy: 'var(--color-practice-xp)',
  result: 'var(--color-practice-accent)',
  league: 'var(--color-practice-gem)',
  streak: 'var(--color-practice-hard)',
};

export default function NotificationsPage() {
  return (
    <AuthGate role="individual">
      <NotificationsPageContent />
    </AuthGate>
  );
}

function NotificationsPageContent() {
  const [items, setItems] = useState(NOTIFICATIONS);
  const [tab, setTab] = useState<'All' | 'Unread'>('All');

  const shown = tab === 'Unread' ? items.filter((n) => n.unread) : items;
  const unread = items.filter((n) => n.unread).length;

  return (
    <PracticeShell>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight mb-2">Notifications</h1>
          <p className="text-[var(--color-practice-ink-soft)]">
            {unread === 0 ? 'You are all caught up.' : `${unread} unread`}
          </p>
        </div>
        {unread > 0 && (
          <button onClick={() => setItems(items.map((n) => ({ ...n, unread: false })))}
                  className="px-5 py-2.5 rounded-[var(--radius-control)] text-sm font-semibold
                             bg-[var(--color-practice-sunken)]
                             text-[var(--color-practice-accent)]">
            Mark all as read
          </button>
        )}
      </div>

      <div className="flex rounded-full p-1 mb-6 w-fit bg-[var(--color-practice-sunken)]">
        {(['All', 'Unread'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t}
                  className={`px-6 py-2 rounded-full text-sm font-semibold transition ${
            tab === t
              ? 'bg-[var(--color-practice-surface)] text-[var(--color-practice-accent)] shadow-sm'
              : 'text-[var(--color-practice-ink-soft)]'
          }`}>
            {t}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-[var(--radius-card)] p-14 text-center
                        border border-dashed border-[var(--color-practice-border)]">
          <p className="font-bold mb-2">Nothing unread</p>
          <p className="text-sm text-[var(--color-practice-ink-soft)]">
            Finish a round and your report will land here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((n) => (
            <button key={n.id}
              onClick={() => setItems(items.map((x) =>
                x.id === n.id ? { ...x, unread: false } : x))}
              className={`w-full text-left flex gap-4 p-5 rounded-[var(--radius-card)] transition
                          border ${
                n.unread
                  ? 'bg-[var(--color-practice-sunken)] border-transparent'
                  : 'bg-[var(--color-practice-surface)] border-[var(--color-practice-border)]'
              }`}>
              <span className="w-11 h-11 shrink-0 rounded-full grid place-items-center text-white"
                    style={{ background: TINT[n.kind] }} aria-hidden="true">
                {ICON[n.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold">{n.title}</span>
                  {n.unread && (
                    <span className="w-2 h-2 rounded-full bg-[var(--color-practice-accent)]">
                      <span className="sr-only">unread</span>
                    </span>
                  )}
                </div>
                <p className="text-sm text-[var(--color-practice-ink-soft)] mt-1">{n.body}</p>
                <div className="text-xs text-[var(--color-practice-ink-mute)] mt-2">{n.when}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </PracticeShell>
  );
}
