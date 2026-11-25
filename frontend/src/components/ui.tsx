import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { PRESETS, useData, usePeriod, type PresetId } from '../context'
import { money, pct } from '../format'
import { AccountOptions } from './AccountOptions'
import type { Transaction, TransactionType } from '../types'

// Blokada przewijania strony pod oknami. Licznik zamiast zapamiętywania poprzedniej wartości:
// przy kilku nakładających się oknach (np. potwierdzenie w imporcie) stara wersja potrafiła
// zostawić stronę na stałe zablokowaną — nie dało się jej przewijać.
let scrollLocks = 0

function applyScrollLock() {
  document.documentElement.classList.toggle('scroll-locked', scrollLocks > 0)
  document.body.style.overflow = ''
}

export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return
    scrollLocks++
    applyScrollLock()
    return () => {
      scrollLocks = Math.max(0, scrollLocks - 1)
      applyScrollLock()
    }
  }, [active])
}

// ---------------- zamykanie okien i niezapisane zmiany ----------------
// Okna z formularzem pilnują niezapisanych zmian: zamknięcie w dowolny sposób (✕, klik obok, Esc,
// „wstecz”, gest przeciągnięcia w dół na telefonie) przy niezapisanych zmianach pyta, czy na pewno
// zamknąć bez zapisywania. Bez zmian okno zamyka się od razu.
//
// Okna `guard` dokładają wpis w historii przeglądarki: „wstecz” (przycisk, gest, klawisz) zamyka
// okno zamiast opuszczać stronę. Po zamknięciu okna wpis jest zdejmowany (history.back) — takie
// zdjęcie nie może być wzięte za „wstecz” użytkownika, stąd licznik i globalny nasłuch.
let pendingBacks = 0
let lastPopProgrammatic = false
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    lastPopProgrammatic = pendingBacks > 0
    if (pendingBacks > 0) pendingBacks--
  })
}

/** „Wstecz” przy otwartym oknie: `onBack` zwraca true, gdy okno zostaje (wpis wraca do historii),
 * false — gdy okno się zamyka. */
export function useNavigationGuard(active: boolean, onBack?: () => boolean) {
  const back = useRef(onBack)
  useEffect(() => {
    back.current = onBack
  })
  useEffect(() => {
    if (!active) return
    const id = Math.random().toString(36).slice(2)
    const push = () => window.history.pushState({ ...(window.history.state ?? {}), finanseGuard: id }, '', window.location.href)
    push()
    const onPop = () => {
      if (lastPopProgrammatic) return
      const stay = back.current ? back.current() : true
      if (stay) push()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if ((window.history.state as { finanseGuard?: string } | null)?.finanseGuard === id) {
        pendingBacks++
        window.history.back()
      }
    }
  }, [active])
}

/** Odświeżenie lub zamknięcie karty pyta o potwierdzenie, gdy są niezapisane zmiany. */
export function useUnloadWarning(active: boolean) {
  useEffect(() => {
    if (!active) return
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [active])
}

// otwarte okna (od najstarszego) — Esc działa tylko na najwyższe
const modalStack: string[] = []
const isTop = (id: string) => modalStack[modalStack.length - 1] === id

/** Pytanie „zamknąć bez zapisywania?” (w oknie albo w imporcie). */
export function CloseConfirm({ onStay, onDiscard, text }: { onStay: () => void; onDiscard: () => void; text?: string }) {
  const stayRef = useRef<HTMLButtonElement>(null)
  useEffect(() => stayRef.current?.focus(), [])
  return (
    <div className="close-confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onStay()}>
      <div className="close-confirm" role="alertdialog" aria-modal="true" aria-label="Niezapisane zmiany">
        <div className="strong">Masz niezapisane zmiany</div>
        <div className="small muted">{text ?? 'Zamknąć okno bez zapisywania? Wprowadzone zmiany zostaną utracone.'}</div>
        <div className="close-confirm-actions">
          <button type="button" className="btn btn-ghost" ref={stayRef} onClick={onStay}>
            Wróć do edycji
          </button>
          <button type="button" className="btn btn-danger" onClick={onDiscard}>
            Zamknij bez zapisu
          </button>
        </div>
      </div>
    </div>
  )
}

/** Czy zdarzenie to zmiana wprowadzona w formularzu okna (a nie np. wyszukiwarka czy rozwinięcie sekcji). */
function isEdit(e: Event): boolean {
  const el = e.target as HTMLElement | null
  if (!el || !el.closest) return false
  if (el.closest('[data-nodirty]')) return false
  if (!el.closest('form')) return false
  if (e.type === 'click') {
    const btn = el.closest('button')
    return !!btn && btn.type === 'button' && !btn.disabled
  }
  return true
}

/** Przeciąganie okna w dół na telefonie (od uchwytu albo gdy treść jest przewinięta do góry). */
function useSwipeToClose(ref: RefObject<HTMLDivElement | null>, onSwipe: () => boolean) {
  const cb = useRef(onSwipe)
  useEffect(() => {
    cb.current = onSwipe
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startX = 0
    let startY = 0
    let dy = 0
    let t0 = 0
    let tracking = false
    let dragging = false
    const mobile = () => {
      try {
        return window.matchMedia('(max-width: 759px)').matches
      } catch {
        return false
      }
    }
    const scrolledInside = (target: HTMLElement | null) => {
      for (let n = target; n && n !== el; n = n.parentElement) {
        if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight) return true
      }
      return el.scrollTop > 0
    }
    const reset = (animate: boolean) => {
      el.style.transition = animate ? 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : ''
      el.style.transform = ''
    }
    const onStart = (e: TouchEvent) => {
      tracking = false
      dragging = false
      if (!mobile() || e.touches.length !== 1) return
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable], [data-noswipe], .close-confirm-backdrop')) return
      if (scrolledInside(target)) return
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      dy = 0
      tracking = true
    }
    const onMove = (e: TouchEvent) => {
      if (!tracking) return
      const x = e.touches[0].clientX - startX
      const y = e.touches[0].clientY - startY
      if (!dragging) {
        if (Math.abs(x) < 8 && Math.abs(y) < 8) return
        if (y <= 0 || Math.abs(x) > Math.abs(y)) {
          tracking = false
          return
        }
        dragging = true
        t0 = performance.now()
        el.style.transition = 'none'
      }
      dy = Math.max(0, y)
      e.preventDefault()
      el.style.transform = `translateY(${dy}px)`
    }
    const onEnd = () => {
      if (!tracking) return
      tracking = false
      if (!dragging) return
      dragging = false
      const speed = dy / Math.max(1, performance.now() - t0)
      if (dy > 120 || (dy > 50 && speed > 0.5)) {
        if (cb.current()) {
          el.style.transition = 'transform 0.18s ease-in'
          el.style.transform = 'translateY(110%)'
          return
        }
      }
      reset(true)
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [ref])
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  actions,
  guard,
  dirty: dirtyProp,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  wide?: boolean
  actions?: ReactNode
  /** okno edycji: „wstecz” (przycisk, gest) zamyka okno zamiast opuszczać stronę */
  guard?: boolean
  /** niezapisane zmiany; bez tej właściwości okno samo wykrywa zmiany w swoim formularzu */
  dirty?: boolean
}) {
  const closeRef = useRef(onClose)
  const sheetRef = useRef<HTMLDivElement>(null)
  const [autoDirty, setAutoDirty] = useState(false)
  const [asking, setAsking] = useState(false)
  const dirty = dirtyProp ?? autoDirty
  const dirtyRef = useRef(dirty)
  const [id] = useState(() => Math.random().toString(36).slice(2))
  useEffect(() => {
    closeRef.current = onClose
    dirtyRef.current = dirty
  })
  /** Próba zamknięcia: bez zmian zamyka, ze zmianami pyta. Zwraca true, gdy okno się zamyka. */
  const requestClose = useCallback(() => {
    if (dirtyRef.current) {
      setAsking(true)
      return false
    }
    closeRef.current()
    return true
  }, [])
  useEffect(() => {
    modalStack.push(id)
    return () => {
      const i = modalStack.lastIndexOf(id)
      if (i >= 0) modalStack.splice(i, 1)
    }
  }, [id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTop(id)) return
      if (asking) setAsking(false)
      else requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, asking, requestClose])
  // zmiany wprowadzone w formularzu okna (pisanie, wybór z listy, kafelki i przełączniki)
  useEffect(() => {
    const el = sheetRef.current
    if (!el || dirtyProp !== undefined) return
    const mark = (e: Event) => isEdit(e) && setAutoDirty(true)
    el.addEventListener('input', mark, true)
    el.addEventListener('change', mark, true)
    el.addEventListener('click', mark, true)
    return () => {
      el.removeEventListener('input', mark, true)
      el.removeEventListener('change', mark, true)
      el.removeEventListener('click', mark, true)
    }
  }, [dirtyProp])
  useNavigationGuard(!!guard, () => !requestClose())
  useUnloadWarning(dirty)
  useSwipeToClose(sheetRef, requestClose)
  useScrollLock()
  // portal do <body>: okno nie może być „uwięzione” w karcie z efektem rozmycia (backdrop-filter
  // tworzy własny układ dla position: fixed — okno było wtedy przycinane i chowało się pod dolnym paskiem)
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div ref={sheetRef} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <div className="row">
            {actions}
            <button className="icon-btn" onClick={requestClose} aria-label="Zamknij">
              ✕
            </button>
          </div>
        </div>
        {children}
      </div>
      {asking && (
        <CloseConfirm
          onStay={() => setAsking(false)}
          onDiscard={() => {
            setAsking(false)
            closeRef.current()
          }}
        />
      )}
    </div>,
    document.body,
  )
}

export function AccountFilter() {
  const { accounts } = useData()
  const { accountId, setAccountId } = usePeriod()
  if (accounts.length === 0) return null
  return (
    <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : undefined)} aria-label="Rachunek">
      <option value="">Wszystkie rachunki</option>
      <AccountOptions accounts={accounts} />
    </select>
  )
}

/** Zakres dat + konto — wspólny dla pulpitu i statystyk. */
export function PeriodPicker({ withAccount = true }: { withAccount?: boolean }) {
  const { preset, period, setPreset, setCustom } = usePeriod()
  return (
    <div className="filters-bar">
      <select value={preset} onChange={(e) => setPreset(e.target.value as PresetId)} aria-label="Okres">
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {preset === 'custom' && (
        <>
          <input type="date" value={period.date_from ?? ''} onChange={(e) => setCustom({ ...period, date_from: e.target.value })} aria-label="Od" />
          <input type="date" value={period.date_to ?? ''} onChange={(e) => setCustom({ ...period, date_to: e.target.value })} aria-label="Do" />
        </>
      )}
      {withAccount && <AccountFilter />}
    </div>
  )
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="sub">{subtitle}</div>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  )
}

export function Kpi({
  label,
  value,
  hint,
  tone,
  delta,
  deltaGoodWhenUp = true,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'income' | 'expense' | 'saving' | 'neutral'
  delta?: number | null
  deltaGoodWhenUp?: boolean
}) {
  let deltaEl = null
  if (delta !== undefined && delta !== null && Number.isFinite(delta)) {
    const up = delta > 0
    const good = delta === 0 ? null : up === deltaGoodWhenUp
    deltaEl = (
      <span className={`delta ${good === null ? '' : good ? 'good' : 'bad'}`}>
        {up ? '↑' : delta < 0 ? '↓' : '•'} {pct(Math.abs(delta), 0)}
      </span>
    )
  }
  return (
    <div className={`kpi kpi-${tone ?? 'neutral'}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {(deltaEl || hint) && (
        <div className="kpi-hint">
          {deltaEl}
          {hint && <span>{hint}</span>}
        </div>
      )}
    </div>
  )
}

export function Dot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color }} />
}

export function CategoryChip({ name, color }: { name: string | null; color: string | null }) {
  if (!name) return <span className="chip chip-empty">Bez kategorii</span>
  return (
    <span className="chip" style={{ ['--c' as string]: color ?? '#8b8b93' }}>
      {name}
    </span>
  )
}

export function Progress({ value, color, over }: { value: number; color?: string; over?: boolean }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)}>
      <div className={`progress-bar ${over ? 'over' : ''}`} style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%`, background: over ? undefined : color }} />
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  )
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="alert alert-error">{error}</div>
}

export function Loading() {
  return <div className="loading">Wczytywanie…</div>
}

/** Pobieranie danych z automatycznym przeładowaniem po zmianie zależności. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    fn()
      .then((d) => {
        if (alive) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, loading, reload: () => setTick((t) => t + 1) }
}

export function useIsMobile(breakpoint = 760): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`
  const get = () => {
    try {
      return window.matchMedia(query).matches
    } catch {
      return false
    }
  }
  const [mobile, setMobile] = useState(get)
  useEffect(() => {
    let mq: MediaQueryList
    try {
      mq = window.matchMedia(query)
    } catch {
      return
    }
    const on = () => setMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return mobile
}

const SIGN: Record<TransactionType, string> = {
  income: '+',
  expense: '−',
  saving_deposit: '',
  saving_withdrawal: '+',
  transfer_out: '',
  transfer_in: '',
}

/** Kwota transakcji: `value` w złotych; dla walut obcych pokazuje kwotę oryginalną (`orig`) i równowartość w zł. */
export function Amount({ value, type, currency, orig }: { value: number; type: TransactionType; currency?: string; orig?: number | null }) {
  const cls = type === 'income' ? 'pos' : type === 'expense' ? 'neg' : type.startsWith('transfer') ? 'trf' : 'sav'
  const foreign = !!currency && currency !== 'PLN' && orig !== null && orig !== undefined
  return (
    <span className={`amount ${cls} ${foreign ? 'amount-fx' : ''}`}>
      <span>
        {SIGN[type]}
        {foreign ? money(orig, currency) : money(value)}
      </span>
      {foreign && <span className="amount-sub">≈ {money(value)}</span>}
    </span>
  )
}

/** Gdzie trafiła transakcja: kategoria, cel oszczędnościowy albo przelew własny. */
export function TxTarget({ t }: { t: Transaction }) {
  const linked = t.pair_id ? ' ✓' : ''
  if (t.type === 'transfer_out' || t.type === 'transfer_in') {
    const other = t.transfer_account_name ?? 'inny rachunek'
    const label = t.type === 'transfer_out' ? `${t.account_name ?? '?'} → ${other}` : `${other} → ${t.account_name ?? '?'}`
    return (
      <span className="chip chip-transfer" title={t.pair_id ? 'Przelew własny — obie strony zapisane' : 'Przelew własny'}>
        ⇄ {label}
        {linked}
      </span>
    )
  }
  if (t.savings_goal_name) {
    const goal = `◎ ${t.savings_goal_name}`
    const acc = t.account_name ?? (t.pair_id ? 'inny cel' : null)
    const label = acc ? (t.type === 'saving_deposit' ? `${acc} → ${goal}` : `${goal} → ${acc}`) : goal
    return (
      <span className="chip chip-saving" title="Przelew własny z udziałem celu oszczędnościowego">
        {label}
        {linked}
      </span>
    )
  }
  // zwrot nie potrzebuje kategorii — znacznik „↩ zwrot” pokazuje TxTags
  if (t.refund_of_id && !t.category_name) return null
  return <CategoryChip name={t.category_name} color={t.category_color} />
}

/** Dodatkowe znaczniki transakcji: sklep, zwrot, zwrócona kwota wydatku. */
export function TxTags({ t }: { t: Transaction }) {
  const { shops } = useData()
  const shop = t.shop_id ? shops.find((s) => s.id === t.shop_id) : undefined
  return (
    <>
      {t.refund_of_id ? (
        <span className="tx-tag tx-tag-refund" title={t.refund_of_label ? `Zwrot za: ${t.refund_of_label}` : 'Zwrot za wydatek'}>
          ↩ zwrot
        </span>
      ) : null}
      {t.refunded ? (
        <span className="tx-tag tx-tag-refund" title="Część lub całość tego wydatku wróciła zwrotem">
          zwrócono {money(t.refunded)}
        </span>
      ) : null}
      {t.recurring_id ? (
        <span className="tx-tag tx-tag-recurring" title={t.recurring_name ? `Wydatek stały: ${t.recurring_name}` : 'Wydatek stały'}>
          ↻ stała
        </span>
      ) : null}
      {t.shop_name ? <ShopBadge name={t.shop_name} color={shop?.color} icon={shop?.icon} className="tx-tag truncate" /> : null}
    </>
  )
}

/** Sklep z jego kolorem i emoji (domyślnie 🏪 i kolor motywu). */
export function ShopBadge({
  name,
  color,
  icon,
  className = 'shop-badge',
}: {
  name: string
  color?: string | null
  icon?: string | null
  className?: string
}) {
  return (
    <span className={`${className} shop-look`} title={`Sklep: ${name}`} style={color ? ({ ['--shop' as string]: color } as CSSProperties) : undefined}>
      <span aria-hidden>{icon || '🏪'}</span> {name}
    </span>
  )
}

/** Emoji sklepu do list wyboru (<option>). */
export const shopLabel = (s: { name: string; icon?: string | null }) => `${s.icon || '🏪'} ${s.name}`
