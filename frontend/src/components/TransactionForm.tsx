import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { api } from '../api'
import { useData, usePeriod, useToast } from '../context'
import { fmtAccount, fmtDate, iso, money, PALETTE, today } from '../format'
import type { DuplicateHit, RefundCandidate, Transaction, TransactionType } from '../types'
import { AccountOptions } from './AccountOptions'
import { AccountSelect } from './AccountSelect'
import { RefundPicker } from './RefundPicker'
import { recurringRuleDraft } from './RecurringMark'
import { RuleForm } from '../sections/Rules'
import { candidateLabel, useRefundCandidates, type RefundQuery } from './refunds'
import { useProposals } from './RuleProposals'
import { ErrorBox, Modal, shopLabel } from './ui'

type Kind = 'expense' | 'income' | 'own'

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'expense', label: 'Wydatek', hint: '' },
  { id: 'income', label: 'Wpływ', hint: '' },
  { id: 'own', label: 'Własny', hint: 'przelew między Twoimi rachunkami i celami' },
]

const kindOf = (t: TransactionType): Kind => (t === 'expense' || t === 'income' ? t : 'own')
const parseAmount = (v: string) => Number(v.replace(/\s/g, '').replace(',', '.'))
const fmtInput = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',')
const curLabel = (c: string) => (c === 'PLN' ? 'zł' : c)

const yesterday = () => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return iso(d)
}

const LAST_ACCOUNT = 'finanse_last_account'
function lastAccount(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_ACCOUNT))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}
function rememberAccount(id: number | null) {
  try {
    if (id) localStorage.setItem(LAST_ACCOUNT, String(id))
  } catch {
    /* brak localStorage */
  }
}

/** Punkt przelewu własnego: konto („a:ID”) albo cel oszczędnościowy („g:ID”). */
type Endpoint = string
const ep = (kind: 'a' | 'g', id: number | null | undefined): Endpoint => (id ? `${kind}:${id}` : '')
const parseEp = (v: Endpoint): { account: number | null; goal: number | null } => {
  const [k, id] = v.split(':')
  return { account: k === 'a' ? Number(id) : null, goal: k === 'g' ? Number(id) : null }
}

function initialEndpoints(t: Partial<Transaction> | undefined, def: Endpoint): [Endpoint, Endpoint] {
  const editing = Boolean(t?.id)
  const accOr = (id: number | null | undefined) => (id ? ep('a', id) : editing ? '' : def)
  switch (t?.type) {
    case 'transfer_out':
      return [accOr(t.account_id), ep('a', t.transfer_account_id)]
    case 'transfer_in':
      return [ep('a', t.transfer_account_id), accOr(t.account_id)]
    case 'saving_deposit':
      return [accOr(t.account_id), ep('g', t.savings_goal_id)]
    case 'saving_withdrawal':
      return [ep('g', t.savings_goal_id), accOr(t.account_id)]
    default:
      return [def, '']
  }
}

function EndpointSelect({ value, onChange, label, exclude }: { value: Endpoint; onChange: (v: Endpoint) => void; label: string; exclude?: Endpoint }) {
  const { accounts, goals } = useData()
  const accs = accounts.filter((a) => !a.archived || ep('a', a.id) === value)
  const gs = goals.filter((g) => !g.archived || ep('g', g.id) === value)
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— wybierz —</option>
        <AccountOptions
          accounts={accs}
          valueFor={(a) => ep('a', a.id)}
          disabledOf={(a) => ep('a', a.id) === exclude}
          labelOf={(a) => `${a.name}${a.balance_known ? ` · ${money(a.balance, a.currency)}` : ''}`}
        />
        {gs.length > 0 && (
          <optgroup label="Cele oszczędnościowe">
            {gs.map((g) => (
              <option key={g.id} value={ep('g', g.id)} disabled={ep('g', g.id) === exclude}>
                ◎ {g.name} · {money(g.balance)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  )
}

/** Formularz transakcji (dodawanie i edycja) — bez ramki okna, do osadzenia. */
export function TransactionEditor({ initial, onDone }: { initial?: Partial<Transaction>; onDone: () => void }) {
  const { categories, accounts, rates, currencies, shops, bump, refresh } = useData()
  const { accountId: filterAccount } = usePeriod()
  const toast = useToast()
  const proposals = useProposals()
  const editing = Boolean(initial?.id)
  const initType = initial?.type ?? 'expense'
  const defaultAccount = (() => {
    const id = filterAccount ?? lastAccount()
    return id && accounts.some((a) => a.id === id && !a.archived) ? id : null
  })()
  const accCurrency = (id: number | null | undefined) => accounts.find((a) => a.id === id)?.currency ?? 'PLN'
  const [kind, setKind] = useState<Kind>(kindOf(initType))
  // kwota w walucie transakcji (dla walut obcych — oryginalna, nie przeliczona)
  const initAmount = initial?.amount_orig ?? initial?.amount
  const [amount, setAmount] = useState(initAmount ? fmtInput(initAmount) : '')
  const [currency, setCurrency] = useState<string>(() =>
    initial?.currency && (editing || initial.currency !== 'PLN') ? initial.currency : accCurrency(editing ? initial?.account_id : (initial?.account_id ?? defaultAccount)),
  )
  // przelew między walutami: ile wpłynęło na konto docelowe (puste = wg kursu)
  const [toAmount, setToAmount] = useState('')
  const [date, setDate] = useState(initial?.date ?? today())
  const [categoryId, setCategoryId] = useState<number | null>(initial?.category_id ?? null)
  const [accountId, setAccountId] = useState<number | null>(editing ? (initial?.account_id ?? null) : (initial?.account_id ?? defaultAccount))
  const [[from, to], setEndpoints] = useState<[Endpoint, Endpoint]>(() => initialEndpoints(initial, ep('a', defaultAccount)))
  const [description, setDescription] = useState(initial?.description ?? '')
  const [counterparty, setCounterparty] = useState(initial?.counterparty ?? '')
  const [shopId, setShopId] = useState<number | null>(initial?.shop_id ?? null)
  // zwrot: wpływ powiązany z wcześniejszym wydatkiem (kategoria jak w wydatku, w statystykach pomniejsza wydatek)
  const [refundOf, setRefundOf] = useState<{ id: number; label: string } | null>(
    initial?.refund_of_id ? { id: initial.refund_of_id, label: initial.refund_of_label ?? 'wydatek' } : null,
  )
  const [picking, setPicking] = useState(false)
  const [refundDismissed, setRefundDismissed] = useState(false)
  const [note, setNote] = useState(initial?.note ?? '')
  const [more, setMore] = useState(Boolean(initial?.note || (editing && initial?.counterparty) || (editing && initial?.shop_id)))
  // podpowiedź kategorii przy wpisywaniu opisu; ręczny wybór kategorii ma pierwszeństwo
  const [suggestion, setSuggestion] = useState<{ category_id: number | null; reason: string | null } | null>(null)
  const [catTouched, setCatTouched] = useState(Boolean(initial?.category_id))
  const [newCat, setNewCat] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dupes, setDupes] = useState<DuplicateHit[] | null>(null)
  const dupeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (dupes) dupeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [dupes])

  // przelew między celami: druga strona trzyma drugi cel — dociągamy ją do formularza
  useEffect(() => {
    if (!initial?.id || !initial.pair_id || initial.account_id) return
    let alive = true
    api
      .transaction(initial.pair_id)
      .then((p) => {
        if (!alive || !p.savings_goal_id) return
        setEndpoints(([f, t]) => (initial.type === 'saving_withdrawal' ? [f, t || ep('g', p.savings_goal_id)] : [f || ep('g', p.savings_goal_id), t]))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [initial?.id, initial?.pair_id, initial?.account_id, initial?.type])

  // przelew między walutami w edycji: kwoty obu stron z pary
  useEffect(() => {
    if (!initial?.id || !initial.pair_id || kindOf(initial.type ?? 'expense') !== 'own') return
    let alive = true
    api
      .transaction(initial.pair_id)
      .then((p) => {
        if (!alive || p.currency === initial.currency) return
        const mine = initial.amount_orig ?? initial.amount ?? 0
        const theirs = p.amount_orig ?? p.amount
        const outgoing = initial.type === 'transfer_out' || initial.type === 'saving_deposit'
        setAmount(fmtInput(outgoing ? mine : theirs))
        setToAmount(fmtInput(outgoing ? theirs : mine))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [initial?.id, initial?.pair_id, initial?.type, initial?.currency, initial?.amount, initial?.amount_orig])

  // waluty: źródło przelewu, cel przelewu, waluta wydatku/wpływu
  const fromCur = parseEp(from).account ? accCurrency(parseEp(from).account) : 'PLN'
  const toCur = parseEp(to).account ? accCurrency(parseEp(to).account) : 'PLN'
  const shownCur = kind === 'own' ? fromCur : currency
  const crossCurrency = kind === 'own' && !!from && !!to && fromCur !== toCur
  const rateOf = (c: string) => (c === 'PLN' ? 1 : (rates?.[c] ?? null))
  const amountValue = parseAmount(amount)
  const plnPreview = shownCur !== 'PLN' && Number.isFinite(amountValue) && amountValue > 0 && rateOf(shownCur) !== null ? amountValue * rateOf(shownCur)! : null
  const autoToAmount =
    crossCurrency && Number.isFinite(amountValue) && amountValue > 0 && rateOf(fromCur) !== null && rateOf(toCur) !== null
      ? (amountValue * rateOf(fromCur)!) / rateOf(toCur)!
      : null
  // waluty z zakładki „Waluty” (+ obecna waluta transakcji, gdyby jej kurs usunięto)
  const currencyChoices = [...new Set([...currencies, currency])]

  const catKind = kind === 'income' ? 'income' : 'expense'
  const kindCats = categories.filter((c) => c.kind === catKind)
  const refund = kind === 'income' ? refundOf : null
  const shopChoices = [...shops].sort((a, b) => a.name.localeCompare(b.name, 'pl'))

  // zapytanie o kandydatów na wydatek zwrotu (tylko dla wpływu z kwotą)
  const refundQuery: RefundQuery | null =
    kind === 'income' && Number.isFinite(amountValue) && amountValue > 0
      ? {
          date,
          amount: amountValue,
          currency,
          description: description.trim(),
          counterparty: counterparty.trim() || null,
          account_id: accountId,
          exclude_id: initial?.id ?? null,
        }
      : null
  // podpowiedź „czy to zwrot?” — tylko gdy jest wydatek z tą samą kwotą
  const { items: autoCandidates } = useRefundCandidates(refund || picking || refundDismissed || (editing && initType === 'income') ? null : refundQuery)
  const strongCandidate = autoCandidates?.find((c) => c.reason.startsWith('ta sama kwota')) ?? null

  // podpowiedź kategorii (reguły, potem historia — także dla fragmentu opisu)
  const suggestKey =
    (kind === 'expense' || kind === 'income') && !refund && (description.trim().length >= 3 || counterparty.trim().length >= 3)
      ? JSON.stringify([kind, description.trim(), counterparty.trim(), accountId, currency])
      : ''
  useEffect(() => {
    if (!suggestKey) return
    let alive = true
    const timer = setTimeout(() => {
      const [type, desc, cp, acc, cur] = JSON.parse(suggestKey) as [TransactionType, string, string, number | null, string]
      api
        .suggestCategory({ type, description: desc, counterparty: cp || null, account_id: acc, currency: cur })
        .then((r) => {
          if (!alive) return
          setSuggestion(r.category_id ? r : null)
          if (r.category_id && !catTouched && categories.some((c) => c.id === r.category_id && c.kind === (type === 'income' ? 'income' : 'expense')))
            setCategoryId(r.category_id)
          if (r.shop_id && shopId === null && !catTouched) setShopId(r.shop_id)
        })
        .catch(() => undefined)
    }, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestKey])

  function pickShop(id: number) {
    setShopId(id)
    const hint = shops.find((s) => s.id === id)?.category_id
    if (categoryId === null && hint && kindCats.some((c) => c.id === hint)) setCategoryId(hint)
  }

  function linkRefund(c: RefundCandidate) {
    setRefundOf({ id: c.transaction.id, label: candidateLabel(c) })
    setCategoryId(null)
    setPicking(false)
    setDupes(null)
  }

  async function createCategory(e?: KeyboardEvent) {
    if (e && e.key !== 'Enter') return
    e?.preventDefault()
    const name = (newCat ?? '').trim()
    if (!name) return setNewCat(null)
    try {
      const c = await api.createCategory({ name, kind: catKind, color: PALETTE[categories.length % PALETTE.length] })
      await refresh()
      setCategoryId(c.id)
      setCatTouched(true)
      setNewCat(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function submit(e?: FormEvent, force = false) {
    e?.preventDefault()
    setError(null)
    const value = parseAmount(amount)
    if (!Number.isFinite(value) || value <= 0) return setError('Wpisz kwotę większą od zera')
    const toValue = crossCurrency && toAmount.trim() ? parseAmount(toAmount) : null
    if (toValue !== null && (!Number.isFinite(toValue) || toValue <= 0)) return setError(`Wpisz kwotę w ${toCur} większą od zera albo zostaw pole puste`)
    setBusy(true)
    try {
      if (kind === 'own') {
        if (!from || !to) return setError('Wybierz, z którego rachunku (lub celu) i na który przelewasz')
        if (from === to) return setError('Wybierz dwa różne rachunki lub cele')
        const f = parseEp(from)
        const t = parseEp(to)
        if (!editing && !force && f.account) {
          const hits = await api.checkDuplicates({ date, amount: value, type: 'transfer_out', description: description.trim(), account_id: f.account, currency: fromCur })
          if (hits.length) return setDupes(hits)
        }
        const body = {
          date,
          amount: value,
          to_amount: toValue,
          from_account_id: f.account,
          from_goal_id: f.goal,
          to_account_id: t.account,
          to_goal_id: t.goal,
          description: description.trim(),
          note: note.trim() || null,
        }
        if (editing && initial?.id) await api.updateTransfer(initial.id, body)
        else await api.createTransfer(body)
        rememberAccount(f.account ?? t.account)
        toast(editing ? 'Zapisano przelew' : 'Dodano przelew własny')
      } else {
        const payload = {
          date,
          amount: value,
          type: kind as TransactionType,
          category_id: categoryId,
          savings_goal_id: null,
          account_id: accountId,
          transfer_account_id: null,
          description: description.trim(),
          counterparty: counterparty.trim() || null,
          note: note.trim() || null,
          currency,
          refund_of_id: refund?.id ?? null,
          shop_id: refund ? null : shopId,
        }
        if (!editing && !force) {
          const { refund_of_id: _r, shop_id: _s, ...probe } = payload
          const hits = await api.checkDuplicates({ ...probe, type: kind })
          if (hits.length) return setDupes(hits)
        }
        if (editing && initial?.id) {
          const r = await api.updateTransaction(initial.id, payload)
          if (r.proposal) proposals.show([{ ...r.proposal, transaction_id: initial.id }])
          else toast('Zapisano zmiany')
        } else {
          await api.createTransaction(payload)
          toast(refund ? 'Dodano zwrot' : 'Dodano transakcję')
        }
        rememberAccount(accountId)
      }
      bump()
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // wydatek stały (tylko przy edycji zapisanego wydatku)
  const [rec, setRec] = useState<{ id: number; name: string } | null>(
    initial?.recurring_id ? { id: initial.recurring_id, name: initial.recurring_name ?? 'wydatek stały' } : null,
  )
  const [markOpen, setMarkOpen] = useState(false)
  const canRecur = editing && initType === 'expense' && kind === 'expense'

  async function unpinRecurring() {
    if (!rec || !initial?.id) return
    try {
      await api.excludeFromRecurring(rec.id, initial.id)
      toast(`Odpięto od „${rec.name}” — to teraz zwykły wydatek`)
      setRec(null)
      bump()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function remove() {
    const both = initial?.pair_id ? ' Jeśli druga strona przelewu została wpisana ręcznie, zostanie usunięta razem z nią.' : ''
    if (!initial?.id || !confirm(`Usunąć tę transakcję?${both}`)) return
    await api.deleteTransaction(initial.id)
    toast('Usunięto transakcję')
    bump()
    onDone()
  }

  return (
    <>
    <form onSubmit={submit} className="form">
      <div className="segmented" role="radiogroup" aria-label="Rodzaj">
        {KINDS.map((k) => (
          <button
            type="button"
            key={k.id}
            role="radio"
            aria-checked={kind === k.id}
            title={k.hint || undefined}
            className={`seg seg-${k.id === 'own' ? 'transfer' : k.id} ${kind === k.id ? 'active' : ''}`}
            onClick={() => {
              setKind(k.id)
              setCategoryId(null)
              setDupes(null)
              setPicking(false)
              setCatTouched(false)
              setSuggestion(null)
            }}
          >
            {k.id === 'own' ? '⇄ ' : ''}
            {k.label}
          </button>
        ))}
      </div>

      <label className={`amount-field t-${kind === 'own' ? 'transfer' : kind}`}>
        <input
          inputMode="decimal"
          autoFocus={!editing}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value.replace(/[^\d,.\s]/g, ''))
            setDupes(null)
          }}
          placeholder="0,00"
          aria-label="Kwota"
        />
        {kind === 'own' ? (
          <span className="cur">{curLabel(shownCur)}</span>
        ) : (
          <select className="cur cur-select" value={currency} onChange={(e) => (setCurrency(e.target.value), setDupes(null))} aria-label="Waluta">
            {currencyChoices.map((c) => (
              <option key={c} value={c}>
                {curLabel(c)}
              </option>
            ))}
          </select>
        )}
      </label>
      {plnPreview !== null && <div className="amount-pln small muted">≈ {money(plnPreview)} wg kursu {String(rateOf(shownCur)).replace('.', ',')} zł</div>}
      {shownCur !== 'PLN' && rateOf(shownCur) === null && (
        <div className="amount-pln small muted">Brak kursu {shownCur} — ustaw go w Ustawienia → Waluty (do tego czasu 1:1).</div>
      )}

      <label>
        Opis {kind === 'own' && <span className="muted">(opcjonalnie)</span>}
        <input
          value={description}
          onChange={(e) => {
            setDescription(e.target.value)
            setDupes(null)
          }}
          placeholder={kind === 'own' ? 'np. Na wakacje' : 'np. Zakupy w Lidlu'}
        />
      </label>

      {kind === 'own' ? (
        <div className="own-transfer">
          <EndpointSelect label="Z" value={from} onChange={(v) => setEndpoints([v, to])} exclude={to} />
          <button type="button" className="icon-btn own-swap" onClick={() => setEndpoints([to, from])} aria-label="Zamień kierunek" title="Zamień kierunek">
            ⇅
          </button>
          <EndpointSelect label="Na" value={to} onChange={(v) => setEndpoints([from, v])} exclude={from} />
          {crossCurrency && (
            <label style={{ gridColumn: '1 / -1' }}>
              Wpłynęło na rachunek docelowy ({toCur}) <span className="muted">(opcjonalnie — puste = wg kursu)</span>
              <input
                inputMode="decimal"
                value={toAmount}
                onChange={(e) => setToAmount(e.target.value.replace(/[^\d,.\s]/g, ''))}
                placeholder={autoToAmount !== null ? `≈ ${fmtInput(autoToAmount)}` : '0,00'}
              />
            </label>
          )}
          <p className="hint small muted" style={{ gridColumn: '1 / -1', margin: 0 }}>
            Cele oszczędnościowe działają jak rachunki oszczędnościowe. Przelew między dwoma rachunkami zapisuje się po obu stronach (wypływ i wpływ), więc salda
            obu rachunków się zgadzają, a przelew nie jest wydatkiem ani wpływem.
          </p>
        </div>
      ) : (
          <label>
            Rachunek
            <AccountSelect
              value={accountId}
              onChange={(id) => {
                setAccountId(id)
                setDupes(null)
                // kwotę wpisuje się w walucie konta (np. Revolut EUR → €)
                if (id) setCurrency(accCurrency(id))
              }}
              emptyLabel="— nie przypisano —"
            />
          </label>
      )}

      <div>
        <div className="small muted" style={{ marginBottom: 8 }}>
          Data
        </div>
        <div className="date-row">
          <button type="button" className={`chip-btn ${date === today() ? 'active' : ''}`} onClick={() => (setDate(today()), setDupes(null))}>
            Dziś
          </button>
          <button type="button" className={`chip-btn ${date === yesterday() ? 'active' : ''}`} onClick={() => (setDate(yesterday()), setDupes(null))}>
            Wczoraj
          </button>
          <input type="date" value={date} onChange={(e) => (setDate(e.target.value), setDupes(null))} required aria-label="Data" />
        </div>
      </div>

      {kind !== 'own' && (
        <>
          {kind === 'income' && (
            <div className="refund-box">
              {refund ? (
                <div className="refund-chip" role="status">
                  <span aria-hidden>↩</span>
                  <span className="truncate">
                    <span className="muted">Zwrot za:</span> {refund.label}
                  </span>
                  <button type="button" className="icon-btn" onClick={() => setRefundOf(null)} aria-label="To nie jest zwrot" title="To nie jest zwrot">
                    ✕
                  </button>
                </div>
              ) : picking && refundQuery ? (
                <RefundPicker query={refundQuery} onPick={linkRefund} onClose={() => setPicking(false)} />
              ) : (
                <>
                  {strongCandidate && (
                    <div className="refund-suggest small">
                      <span>
                        Czy to zwrot za <b>{strongCandidate.transaction.counterparty || strongCandidate.transaction.description || 'wydatek'}</b> z{' '}
                        {fmtDate(strongCandidate.transaction.date)}?
                      </span>
                      <span className="row">
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => linkRefund(strongCandidate)}>
                          Tak, powiąż
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" data-nodirty onClick={() => setRefundDismissed(true)}>
                          Nie
                        </button>
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn-text refund-toggle"
                    data-nodirty
                    disabled={!refundQuery}
                    title={refundQuery ? undefined : 'Najpierw wpisz kwotę'}
                    onClick={() => setPicking(true)}
                  >
                    ↩ To zwrot za wydatek…
                  </button>
                </>
              )}
            </div>
          )}
          {kind === 'expense' && initial?.refunded ? (
            <div className="refund-chip small" role="status">
              <span aria-hidden>↩</span>
              <span>Z tego wydatku wróciło już {money(initial.refunded)} zwrotem — w statystykach liczy się tylko reszta.</span>
            </div>
          ) : null}
          {refund ? (
            <p className="hint small muted" style={{ margin: 0 }}>
              Zwrot dostaje kategorię wydatku i w statystykach pomniejsza ten wydatek — nie liczy się jako wpływ.
            </p>
          ) : (
          <div>
            <div className="label small muted" style={{ marginBottom: 8 }}>
              Kategoria
              {suggestion && suggestion.category_id === categoryId && (
                <span className="cat-suggest" title={suggestion.reason ?? undefined}>
                  {' '}
                  · podpowiedź{suggestion.reason ? ` (${suggestion.reason})` : ''} — możesz zmienić
                </span>
              )}
            </div>
            <div className="pick-grid">
              {kindCats.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`pick ${categoryId === c.id ? 'active' : ''}`}
                  style={{ ['--c' as string]: c.color }}
                  onClick={() => {
                    setCategoryId(categoryId === c.id ? null : c.id)
                    setCatTouched(true)
                    setDupes(null)
                  }}
                >
                  <span aria-hidden>{c.icon ?? '●'}</span>
                  {c.name}
                </button>
              ))}
              {newCat === null ? (
                <button type="button" className="pick pick-new" onClick={() => setNewCat('')}>
                  ＋ Nowa kategoria
                </button>
              ) : (
                <input
                  className="pick-input"
                  autoFocus
                  value={newCat}
                  placeholder="Nazwa i Enter"
                  onChange={(e) => setNewCat(e.target.value)}
                  onKeyDown={createCategory}
                  onBlur={() => createCategory()}
                />
              )}
            </div>
          </div>
          )}
        </>
      )}

      {!more ? (
        <button type="button" className="btn btn-text more-toggle" data-nodirty onClick={() => setMore(true)}>
          ＋ Dodatkowe ({kind === 'own' ? 'notatka' : refund ? 'kontrahent, notatka' : 'kontrahent, sklep, notatka'})
          {kind !== 'own' && (counterparty || shopId !== null) ? ' · uzupełnione' : ''}
        </button>
      ) : (
        <fieldset className="more-box">
          <legend className="small muted">
            Dodatkowe{' '}
            <button type="button" className="btn btn-text btn-sm" data-nodirty onClick={() => setMore(false)}>
              zwiń
            </button>
          </legend>
          {kind !== 'own' && (
            <label>
              {kind === 'income' ? 'Od kogo (źródło wpływu)' : 'Kontrahent'}
              <input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder="np. ACME sp. z o.o." />
              <span className="field-hint">Na tej podstawie aplikacja zapamiętuje kategorię dla kolejnych transakcji z tego źródła.</span>
            </label>
          )}
          {kind !== 'own' && !refund && shopChoices.length > 0 && (
              <label>
                Sklep <span className="muted">(opcjonalnie)</span>
                <span className="shop-row">
                  <select value={shopId ?? ''} onChange={(e) => pickShop(Number(e.target.value))} aria-label="Sklep">
                    <option value="" disabled hidden>
                      — wybierz sklep —
                    </option>
                    {shopChoices.map((s) => (
                      <option key={s.id} value={s.id}>
                        {shopLabel(s)}
                      </option>
                    ))}
                  </select>
                  {shopId !== null && (
                    <button type="button" className="icon-btn" onClick={() => setShopId(null)} aria-label="Wyczyść sklep" title="Wyczyść">
                      ✕
                    </button>
                  )}
                </span>
              </label>
            )}
          <label>
            Notatka
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </label>
        </fieldset>
      )}

      {(initial?.title || initial?.counterparty_account) && (
        <div className="alert small">
          {initial.title && (
            <div>
              <span className="muted">Tytuł z wyciągu:</span> {initial.title}
            </div>
          )}
          {initial.counterparty_account && (
            <div>
              <span className="muted">Rachunek kontrahenta:</span> {fmtAccount(initial.counterparty_account)}
            </div>
          )}
        </div>
      )}

      {dupes && (
        <div className="dupe-warn" role="alert" ref={dupeRef}>
          <div className="strong">To prawdopodobnie duplikat — podobna transakcja już istnieje:</div>
          <ul>
            {dupes.map((h) => (
              <li key={h.transaction.id}>
                <div className="dupe-line">
                  <span className="tiny muted nowrap">{fmtDate(h.transaction.date)}</span>
                  <span className="truncate">{h.transaction.counterparty || h.transaction.description || '(brak opisu)'}</span>
                  <span className="amount small">{h.transaction.currency !== 'PLN' && h.transaction.amount_orig != null ? money(h.transaction.amount_orig, h.transaction.currency) : money(h.transaction.amount)}</span>
                </div>
                <div className="tiny muted">
                  {h.reason}
                  {h.transaction.account_name ? ` · ${h.transaction.account_name}` : ''}
                  {h.transaction.category_name ? ` · ${h.transaction.category_name}` : ''}
                </div>
              </li>
            ))}
          </ul>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => submit(undefined, true)}>
              Dodaj mimo to
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
              Nie dodawaj
            </button>
          </div>
        </div>
      )}

      {canRecur && (
        <div className="tx-recurring-box small" data-nodirty>
          {rec ? (
            <>
              <span>
                ↻ Wydatek stały: <strong>{rec.name}</strong>
              </span>
              <span className="spacer" />
              <button type="button" className="btn btn-text btn-sm" onClick={unpinRecurring} title="To jednorazowy wydatek — nie należy do tego wydatku stałego">
                Odepnij
              </button>
            </>
          ) : (
            <>
              <span className="muted">Powtarza się regularnie?</span>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMarkOpen(true)}>
                ↻ Oznacz jako wydatek stały
              </button>
            </>
          )}
        </div>
      )}
      <ErrorBox error={error} />
      {!dupes && (
        <div className="sheet-actions">
          {editing && (
            <button type="button" className="btn btn-danger" onClick={remove}>
              Usuń
            </button>
          )}
          <button className="btn btn-primary btn-lg" style={{ flex: 1 }} disabled={busy}>
            {busy ? 'Zapisywanie…' : editing ? 'Zapisz zmiany' : kind === 'own' ? 'Przelej' : 'Dodaj'}
          </button>
        </div>
      )}
    </form>
    {markOpen && initial?.id && (
      <RuleForm
        title="Reguła wydatku stałego"
        initial={recurringRuleDraft({ ...initial, category_id: categoryId ?? initial.category_id })}
        onClose={() => setMarkOpen(false)}
        onSaved={async () => {
          // reguła z opcją „wydatek stały” od razu przypisała pasujące wydatki — także ten
          const t = await api.transaction(initial.id!).catch(() => null)
          if (t?.recurring_id) {
            setRec({ id: t.recurring_id, name: t.recurring_name ?? 'wydatek stały' })
            toast(`Dodano regułę — „${t.recurring_name ?? 'wydatek stały'}” to teraz wydatek stały. Kolejne pasujące wydatki przypiszę same.`)
          } else toast('Dodano regułę, ale ten wydatek do niej nie pasuje — sprawdź wzorzec reguły.')
        }}
      />
    )}
    </>
  )
}

/** Okno edycji istniejącej transakcji. */
export function TransactionForm({ initial, onClose, onSaved }: { initial?: Partial<Transaction>; onClose: () => void; onSaved: () => void }) {
  return (
    <Modal title={initial?.id ? 'Transakcja' : 'Nowa transakcja'} onClose={onClose} guard>
      <TransactionEditor initial={initial} onDone={onSaved} />
    </Modal>
  )
}
