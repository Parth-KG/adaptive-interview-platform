'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { SignOutButton } from '@/components/ui/AuthGate';
import { getSupabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, BookOpen, BriefcaseBusiness, ChevronDown, CircleHelp, FileBarChart, LayoutDashboard, PlayCircle, Plus, Search, Settings, Users, Video } from 'lucide-react';

const NAV = [
  { href: '/enterprise', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/enterprise/interviews', label: 'Interviews', icon: BriefcaseBusiness },
  { href: '/enterprise/question-banks', label: 'Question Banks', icon: BookOpen },
  { href: '/enterprise/candidates', label: 'Candidates', icon: Users },
  { href: '/enterprise/live', label: 'Live Sessions', icon: Video },
  { href: '/enterprise/reports', label: 'Reports', icon: FileBarChart },
  { href: '/enterprise/team', label: 'Team', icon: Users },
];

function routeIsActive(pathname: string, href: string) {
  if (href === '/enterprise') return pathname === href;
  if (href === '/enterprise/interviews') return pathname.startsWith('/enterprise/interviews') || pathname.startsWith('/enterprise/templates') || pathname.startsWith('/enterprise/builder');
  if (href === '/enterprise/candidates') return pathname.startsWith('/enterprise/candidates') || pathname.startsWith('/enterprise/pipeline') || pathname.startsWith('/enterprise/invitations') || pathname.startsWith('/enterprise/comparison');
  return pathname.startsWith(href);
}

export function ConsoleShell({ title, subtitle, actions, eyebrow, breadcrumb, children, flush = false }: { title?: string; subtitle?: string; actions?: ReactNode; eyebrow?: string; breadcrumb?: string; children: ReactNode; flush?: boolean }) {
  // The console header used to hardcode a name that belonged to nobody.
  const [operator, setOperator] = useState<string>('');
  useEffect(() => {
    let active = true;
    getSupabase().auth.getUser()
      .then(({ data }) => {
        if (!active) return;
        const u = data.user;
        const meta = (u?.user_metadata ?? {}) as Record<string, unknown>;
        const named = typeof meta.display_name === 'string' ? meta.display_name
          : typeof meta.full_name === 'string' ? meta.full_name : '';
        setOperator(named.trim() || (u?.email ?? '').split('@')[0] || '');
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  const pathname = usePathname();
  const interviewMatch = pathname.match(/^\/enterprise\/interviews\/([^/]+)$/);
  const testPanelId = interviewMatch?.[1];
  return (
    <div className="min-h-screen bg-[#f7f8fa] text-[#141414] lg:flex">
      <aside className="hidden min-h-screen w-[244px] shrink-0 flex-col border-r border-[#e5e7eb] bg-white lg:flex">
        <Link href="/enterprise" className="flex h-[74px] items-center gap-3 border-b border-[#edf0f2] px-7"><span className="grid size-9 place-items-center rounded-lg bg-black text-sm font-bold text-white">R</span><span className="font-serif text-[22px] font-bold tracking-tight">RecruitPro</span></Link>
        <div className="px-4 py-5"><Link href="/enterprise/templates" className="flex h-11 items-center justify-center gap-2 rounded-lg bg-black text-sm font-semibold text-white transition hover:bg-[#252525]"><Plus size={17} /> New Interview</Link></div>
        <nav className="space-y-1 px-3">
          {NAV.map(({ href, label, icon: Icon }) => { const active = routeIsActive(pathname, href); return <Link key={href} href={href} className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm transition ${active ? 'bg-[#f0f2f5] font-semibold text-black' : 'text-[#60646c] hover:bg-[#f7f8fa] hover:text-black'}`}><Icon size={18} strokeWidth={1.8} /> {label}</Link>; })}
        </nav>
        <div className="mt-auto space-y-1 border-t border-[#edf0f2] px-3 py-4">
          <Link href="/enterprise/support" className="flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm text-[#60646c] hover:bg-[#f7f8fa]"><CircleHelp size={18}/> Support</Link>
          <Link href="/enterprise/settings" className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm ${pathname.startsWith('/enterprise/settings') || pathname === '/enterprise/audit-log' ? 'bg-[#f0f2f5] font-semibold text-black' : 'text-[#60646c] hover:bg-[#f7f8fa]'}`}><Settings size={18}/> Settings</Link>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-[74px] items-center border-b border-[#e5e7eb] bg-white px-5 lg:px-8">
          <Link href="/enterprise" className="font-serif text-xl font-bold lg:hidden">RecruitPro</Link>
          {testPanelId && <button onClick={()=>window.open(`/enterprise/interviews/${testPanelId}/test`,'recruitpro-interview-test','popup=yes,width=1400,height=900,left=40,top=40,resizable=yes,scrollbars=yes')} className="ml-auto inline-flex h-10 items-center gap-2 rounded-lg border border-[#d9dce1] bg-white px-4 text-sm font-semibold hover:border-black"><PlayCircle size={17}/> Test interview</button>}
          <div className={`relative hidden w-[300px] md:block ${testPanelId?'ml-3':'ml-auto'}`}><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8b9098]" /><input aria-label="Search" placeholder="Search candidates, interviews..." className="h-10 w-full rounded-lg border border-[#e2e5e9] bg-[#f8f9fa] pl-9 pr-3 text-sm outline-none focus:border-black" /></div>
          <Link href="/enterprise/notifications" aria-label="Notifications" className="relative ml-4 grid size-10 place-items-center rounded-full border border-[#e2e5e9]"><Bell size={18}/><span className="absolute right-2 top-2 size-1.5 rounded-full bg-red-500"/></Link>
          <div className="ml-3 flex items-center gap-2"><span className="grid size-8 place-items-center rounded-full bg-[#d9e7ff] text-xs font-bold">{(operator||'?').charAt(0).toUpperCase()}</span><span className="hidden text-sm font-medium xl:inline">{operator||'Account'}</span><SignOutButton/></div>
        </header>
        <main className={flush ? '' : 'mx-auto max-w-[1440px] px-5 py-7 lg:px-9 lg:py-9'}>
          {!flush && (title || subtitle || actions) && <div className="mb-8 flex flex-wrap items-start justify-between gap-5"><div>{(eyebrow || breadcrumb) && <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-[#737780]">{eyebrow || breadcrumb}</p>}{title && <h1 className="font-serif text-3xl font-bold tracking-tight lg:text-[38px]">{title}</h1>}{subtitle && <p className="mt-2 max-w-2xl text-sm leading-6 text-[#666b73]">{subtitle}</p>}</div>{actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}</div>}
          {children}
        </main>
      </div>
    </div>
  );
}

export function ConsoleButton({ children, variant = 'solid', href, type = 'button', onClick }: { children: ReactNode; variant?: 'solid' | 'outline' | 'soft' | 'danger' | 'ghost'; href?: string; type?: 'button' | 'submit'; onClick?: () => void }) {
  const cls = `inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition ${variant === 'solid' ? 'bg-black text-white hover:bg-[#292929]' : variant === 'danger' ? 'bg-[#b42318] text-white' : variant === 'soft' || variant === 'ghost' ? 'bg-[#f0f2f5] text-[#292b2f] hover:bg-[#e7e9ec]' : 'border border-[#d9dce1] bg-white hover:border-[#999]'}`;
  return href ? <Link href={href} className={cls}>{children}</Link> : <button type={type} onClick={onClick} className={cls}>{children}</button>;
}

export function ConsoleCard({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) { return <section className={`rounded-xl border border-[#e3e5e8] bg-white ${className}`}>{title && <h2 className="mb-4 font-serif text-xl font-bold">{title}</h2>}{children}</section>; }

export function StatusPill({ children, tone = 'gray' }: { children: ReactNode; tone?: 'green' | 'blue' | 'amber' | 'red' | 'gray' | 'active' | 'draft' | 'done' }) {
  const tones = { green: 'bg-[#eaf7ee] text-[#257a3e]', blue: 'bg-[#eaf1ff] text-[#315ca8]', amber: 'bg-[#fff4dd] text-[#94620a]', red: 'bg-[#fdeceb] text-[#a93a32]', gray: 'bg-[#eff1f3] text-[#5f646c]', active: 'bg-[#eaf7ee] text-[#257a3e]', draft: 'bg-[#fff4dd] text-[#94620a]', done: 'bg-[#eaf1ff] text-[#315ca8]' };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}><span className="size-1.5 rounded-full bg-current"/>{children}</span>;
}
