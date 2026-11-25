import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { AddProvider, useAuth, useData, useToast, type AddMode } from '../context'
import { useSettings } from '../settings'
import type { Transaction } from '../types'
import { plural } from '../format'
import { AddSheet, type ImportStart } from './AddSheet'
import { ImportReview } from './ImportReview'
import { useProposals } from './RuleProposals'
import { Avatar } from './avatars'

export function BrandMark({ size = 28 }: { size?: number }) {
  // ta sama grafika co ikona aplikacji (public/icon.svg): złota moneta z rosnącym wykresem
  return (
    <span className="brand-mark" aria-hidden>
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <defs>
          <linearGradient id="bm-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4338ca" />
            <stop offset="0.55" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#c026d3" />
          </linearGradient>
          <linearGradient id="bm-coin" x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0" stopColor="#fff1b8" />
            <stop offset="0.45" stopColor="#fcd34d" />
            <stop offset="1" stopColor="#f59e0b" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="url(#bm-bg)" />
        <circle cx="16" cy="16.8" r="11" fill="#c2700a" />
        <circle cx="16" cy="16" r="11" fill="url(#bm-coin)" />
        <path d="M10 20 L14 16 L17 18.5 L21.5 13.5" fill="none" stroke="#3b0764" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M18.6 12.6 L22.6 12.2 L22.2 16.2 Z" fill="#3b0764" stroke="#3b0764" strokeWidth="1" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

const NAV = [
  { to: '/', label: 'Pulpit', icon: '◧', end: true },
  { to: '/statystyki', label: 'Statystyki', icon: '▥' },
  { to: '/ustawienia', label: 'Ustawienia', icon: '⚙' },
]

function UserMenu() {
  const { user, logout, local } = useAuth()
  const { resolvedTheme, update } = useSettings()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="menu" ref={ref}>
      <button className={`avatar ${user?.avatar ? 'avatar-pic' : ''}`} onClick={() => setOpen((o) => !o)} aria-label="Menu użytkownika">
        {user?.avatar ? <Avatar id={user.avatar} name={user.name} size={36} /> : user?.name.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="menu-pop">
          <NavLink className="menu-head menu-head-link" to="/ustawienia?s=konto" onClick={() => setOpen(false)}>
            <Avatar id={user?.avatar} name={user?.name} size={36} />
            <span style={{ minWidth: 0 }}>
              <span className="strong truncate" style={{ display: 'block' }}>
                {user?.name}
              </span>
              <span className="small muted">{local ? 'dane na tym urządzeniu' : `@${user?.username}`}</span>
            </span>
          </NavLink>
          <NavLink className="menu-item" to="/ustawienia?s=konto" onClick={() => setOpen(false)}>
            ☺ Konto
          </NavLink>
          <button className="menu-item" onClick={() => update({ theme: resolvedTheme === 'dark' ? 'light' : 'dark' })}>
            {resolvedTheme === 'dark' ? '☀' : '☾'} Motyw {resolvedTheme === 'dark' ? 'jasny' : 'czarny'}
          </button>
          <NavLink className="menu-item" to="/ustawienia?s=wyglad" onClick={() => setOpen(false)}>
            ✦ Wygląd
          </NavLink>
          {local ? (
            <NavLink className="menu-item" to="/ustawienia?s=dane" onClick={() => setOpen(false)}>
              ⛁ Dane i kopia zapasowa
            </NavLink>
          ) : (
            <button className="menu-item" onClick={logout}>
              ⎋ Wyloguj
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Layout() {
  const { bump } = useData()
  const toast = useToast()
  const proposals = useProposals()
  const location = useLocation()
  const [add, setAdd] = useState<{ mode: AddMode; initial?: Partial<Transaction> } | null>(null)
  const [review, setReview] = useState<ImportStart | null>(null)
  const addCtx = useMemo(() => ({ open: (o?: { mode?: AddMode; initial?: Partial<Transaction> }) => setAdd({ mode: o?.mode ?? 'manual', initial: o?.initial }) }), [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  return (
    <AddProvider value={addCtx}>
      <header className="topbar">
        <NavLink to="/" className="brand">
          <BrandMark />
          <span>Finance View</span>
        </NavLink>
        <nav className="topnav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <span className="spacer" />
        <button className="btn btn-primary hide-mobile" onClick={() => addCtx.open()}>
          + Dodaj
        </button>
        <UserMenu />
      </header>

      <main className="content">
        <Outlet />
      </main>

      <nav className="bottomnav" aria-label="Nawigacja">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="nav-ico">◧</span>Pulpit
        </NavLink>
        <NavLink to="/statystyki" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="nav-ico">▥</span>Statystyki
        </NavLink>
        <button className="fab" onClick={() => addCtx.open()} aria-label="Dodaj transakcję lub zaimportuj wyciąg">
          +
        </button>
        <button className="nav-plain" onClick={() => addCtx.open({ mode: 'import' })}>
          <span className="nav-ico">⇪</span>Import
        </button>
        <NavLink to="/ustawienia" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="nav-ico">⚙</span>Ustawienia
        </NavLink>
      </nav>

      {add && (
        <AddSheet
          mode={add.mode}
          initial={add.initial}
          onClose={() => setAdd(null)}
          onImport={(s) => {
            setAdd(null)
            setReview(s)
          }}
        />
      )}
      {review && (
        <ImportReview
          files={review.files}
          bank={review.bank}
          initial={review.preview}
          accountIds={review.accountIds}
          onClose={() => setReview(null)}
          onDone={(r) => {
            setReview(null)
            bump()
            toast(
              `Dodano ${r.imported_count} ${plural(r.imported_count, 'transakcję', 'transakcje', 'transakcji')}${
                r.skipped_count ? `, pominięto ${r.skipped_count}` : ''
              }${r.learned_rules ? ` · zapamiętano ${r.learned_rules} ${plural(r.learned_rules, 'regułę', 'reguły', 'reguł')}` : ''}${
                r.created_accounts?.length ? ` · nowe rachunki: ${r.created_accounts.join(', ')}` : ''
              }.`,
            )
            // nowe reguły pasują do starszych transakcji bez kategorii — zapytaj, czy je uzupełnić
            if (r.proposals?.length) proposals.show(r.proposals)
          }}
        />
      )}
    </AddProvider>
  )
}
