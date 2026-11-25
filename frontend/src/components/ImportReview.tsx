import { useMemo, useState } from 'react'
import { fuzzyMatch } from '../fuzzy'
import { api } from '../api'
import { useData, useToast } from '../context'
import { BANK_LABEL, fmtDate, isSaving, isTransfer, money, plural } from '../format'
import { RuleForm } from '../sections/Rules'
import type { ImportCommitResult, ImportPreview, ImportRow, LearnRule, Rule, RuleField, RuleInput, TransactionType } from '../types'
import { AccountSelect } from './AccountSelect'
import { TransferOptions } from './AccountOptions'
import { NewCategoryModal } from './NewCategory'
import { CloseConfirm, ErrorBox, Modal, useIsMobile, useNavigationGuard, useScrollLock, useUnloadWarning } from './ui'

type Tab = 'all' | 'uncat' | 'dup' | 'special' | 'removed'

interface Row extends ImportRow {
  removed?: boolean
}

interface Props {
  files: File[]
  bank: string
  initial: ImportPreview
  accountIds: (number | null)[]
  onClose: () => void
  onDone: (r: ImportCommitResult) => void
}

const EDITABLE: (keyof Row)[] = [
  'description',
  'note',
  'type',
  'category_id',
  'savings_goal_id',
  'transfer_account_id',
  'include',
  'removed',
  'reason',
  'refund_of_id',
  'refund_of_hash',
  'refund_of_label',
]
const ruleReason = (rule: { field: RuleField; pattern: string }) => `reguła: ${FIELD_LABEL[rule.field as RuleField] ?? rule.field} „${rule.pattern}”`
const ruleTarget = (r: { mark_transfer: boolean; transfer_account_id: number | null; savings_goal_id: number | null; category_id: number | null }) =>
  r.mark_transfer ? `t:${r.transfer_account_id ?? ''}` : r.savings_goal_id ? `g:${r.savings_goal_id}` : r.category_id ? `c:${r.category_id}` : ''
const isRefundRow = (r: { refund_of_id?: number | null; refund_of_hash?: string | null }) => !!(r.refund_of_id || r.refund_of_hash)
const MINE = 'Twój wybór'
const SAME_SOURCE = 'jak inne z tego źródła'
const FIELD_LABEL: Record<RuleField, string> = {
  counterparty: 'kontrahent',
  description: 'opis',
  title: 'tytuł',
  counterparty_account: 'nr rachunku',
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/\s+/g, ' ').trim()

function groupKey(r: Row): string | null {
  if (!r.learn_pattern || !r.learn_field) return null
  return `${r.learn_field}|${fold(r.learn_pattern)}|${r.amount < 0 ? 'expense' : 'income'}`
}

function assignmentValue(r: Row): string {
  if (isTransfer(r.type)) return `t:${r.transfer_account_id ?? ''}`
  if (r.savings_goal_id) return `g:${r.savings_goal_id}`
  return r.category_id ? `c:${r.category_id}` : ''
}

function applyAssignment(r: Row, value: string, reason: string | null): Partial<Row> {
  const out = r.amount < 0
  const [k, id] = value.split(':')
  if (k === 't') return { type: (out ? 'transfer_out' : 'transfer_in') as TransactionType, transfer_account_id: id ? Number(id) : null, savings_goal_id: null, category_id: null, reason }
  if (k === 'g') return { type: (out ? 'saving_deposit' : 'saving_withdrawal') as TransactionType, savings_goal_id: Number(id), transfer_account_id: null, category_id: null, reason }
  return { type: (out ? 'expense' : 'income') as TransactionType, category_id: id ? Number(id) : null, savings_goal_id: null, transfer_account_id: null, reason }
}

/** Czy podpowiedź pochodzi z istniejącej wiedzy, której nie trzeba zapamiętywać ponownie. */
const knownReason = (reason: string | null) =>
  !!reason && reason !== MINE && reason !== SAME_SOURCE && reason !== 'podobne wcześniejsze transakcje'

interface LearnGroup {
  key: string
  field: RuleField
  pattern: string
  direction: 'expense' | 'income'
  count: number
  value: string
  conflict: boolean
  change: boolean
}

export function ImportReview({ files, bank, initial, accountIds: initialAccounts, onClose, onDone }: Props) {
  const { categories, goals, accounts, shops } = useData()
  const toast = useToast()
  const mobile = useIsMobile(1100)
  const [preview, setPreview] = useState(initial)
  const [rows, setRows] = useState<Row[]>(initial.rows)
  const [accountIds, setAccountIds] = useState<(number | null)[]>(initial.files.map((f, i) => f.account_id ?? initialAccounts[i] ?? null))
  const [edited, setEdited] = useState<Set<string>>(new Set())
  const [mine, setMine] = useState<Set<string>>(new Set())
  const [learnOff, setLearnOff] = useState<Set<string>>(new Set())
  const [learnPattern, setLearnPattern] = useState<Record<string, string>>({})
  // domyślnie pokazujemy pozycje bez kategorii (to je trzeba uzupełnić); gdy ich brak — wszystkie
  // okno „nowa kategoria” dla wiersza (indeks)
  const [newCatFor, setNewCatFor] = useState<number | null>(null)
  // nowa reguła tworzona w trakcie importu (od razu aktualizuje pasujące pozycje)
  const [ruleFor, setRuleFor] = useState<Partial<Rule> | null>(null)
  // reguły zapisane w trakcie tego importu (widać je w panelu „Zapamiętam na przyszłość”)
  const [createdRules, setCreatedRules] = useState<Rule[]>([])
  // poprawki reguł zapamiętywanych automatycznie (pełny formularz, bez zapisu do zatwierdzenia importu)
  const [learnEdit, setLearnEdit] = useState<Record<string, RuleInput>>({})
  const [draftKey, setDraftKey] = useState<string | null>(null)
  const [tab, setTabRaw] = useState<Tab>(() =>
    initial.rows.some((r) => (r.type === 'expense' || r.type === 'income') && !r.category_id && r.include && !isRefundRow(r)) ? 'uncat' : 'all',
  )
  // pozycje uzupełnione w zakładce „Bez kategorii” zostają widoczne do zmiany zakładki
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const setTab = (t: Tab) => {
    setTabRaw(t)
    setPinned(new Set())
  }
  const [q, setQ] = useState('')
  // ukrywanie duplikatów na liście (nie zmienia tego, czy zostaną dodane) — zapamiętane na urządzeniu
  const [hideDup, setHideDupRaw] = useState(() => {
    try {
      return localStorage.getItem('finanse_hide_dups') === '1'
    } catch {
      return false
    }
  })
  const setHideDup = (v: boolean) => {
    setHideDupRaw(v)
    try {
      localStorage.setItem('finanse_hide_dups', v ? '1' : '0')
    } catch {
      /* brak dostępu do pamięci */
    }
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [noteOpen, setNoteOpen] = useState<Set<string>>(new Set())
  const dirty = edited.size > 0

  // zamknięcie (✕, Anuluj, „wstecz”) z poprawkami pyta, czy porzucić import; bez poprawek zamyka od razu
  const [asking, setAsking] = useState(false)
  function close(): boolean {
    if (dirty) {
      setAsking(true)
      return false
    }
    onClose()
    return true
  }
  useNavigationGuard(true, () => (ruleFor || draftKey || newCatFor !== null || confirming ? true : !close()))
  useUnloadWarning(dirty)
  useScrollLock()

  function markEdited(hashes: string[]) {
    // w zakładce „Bez kategorii” uzupełnione pozycje zostają widoczne do zmiany zakładki
    if (tab === 'uncat') setPinned((p) => new Set([...p, ...hashes]))
    setEdited((e) => {
      const n = new Set(e)
      hashes.forEach((h) => n.add(h))
      return n
    })
  }

  function patch(i: number, p: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...p } : r)))
    markEdited([rows[i].hash])
  }

  function patchMany(indices: number[], fn: (r: Row) => Partial<Row>) {
    const set = new Set(indices)
    setRows((rs) => rs.map((r, idx) => (set.has(idx) ? { ...r, ...fn(r) } : r)))
    markEdited(indices.map((i) => rows[i].hash))
  }

  /** Przypisanie wybrane przez Ciebie + to samo dla innych pozycji z tego samego źródła. */
  function assign(i: number, value: string) {
    const r = rows[i]
    const key = groupKey(r)
    const before = rows
    const beforeMine = mine
    const others =
      value && key
        ? rows.map((x, idx) => ({ x, idx })).filter(({ x, idx }) => idx !== i && !x.removed && !mine.has(x.hash) && groupKey(x) === key && assignmentValue(x) !== value).map(({ idx }) => idx)
        : []
    const set = new Set(others)
    setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, ...applyAssignment(x, value, MINE) } : set.has(idx) ? { ...x, ...applyAssignment(x, value, SAME_SOURCE) } : x)))
    setMine((m) => new Set(m).add(r.hash))
    markEdited([r.hash, ...others.map((o) => rows[o].hash)])
    if (others.length) {
      toast(`Przypisano też ${others.length} ${others.length === 1 ? 'pozycji' : 'pozycjom'} z tego samego źródła.`, {
        label: 'Cofnij',
        run: () => {
          setRows(before)
          setMine(beforeMine)
        },
      })
    }
  }

  /** Reguła wypełniona danymi wiersza: źródło (kontrahent/opis), kierunek i bieżące przypisanie. */
  function ruleFromRow(r: Row): Partial<Rule> {
    const v = assignmentValue(r)
    const [k, id] = v.split(':')
    return {
      pattern: r.learn_pattern ?? (r.counterparty || r.description).slice(0, 60),
      field: (r.learn_field as RuleField | null) ?? 'description',
      direction: r.amount < 0 ? 'expense' : 'income',
      category_id: k === 'c' && id ? Number(id) : null,
      savings_goal_id: k === 'g' && id ? Number(id) : null,
      mark_transfer: k === 't',
      transfer_account_id: k === 't' && id ? Number(id) : null,
      shop_id: r.shop_id ?? null,
    }
  }

  /** Pozycje, które reguła może zmienić: wszystkie poza usuniętymi, sparowanymi przelewami
   * własnymi, operacjami rozpoznanymi po numerze rachunku albo typie Revolut i zwrotami. */
  const ruleEligible = useMemo(
    () =>
      rows
        .map((x, i) => ({ x, i }))
        .filter(
          ({ x }) =>
            !x.removed &&
            !x.pair_hash &&
            !x.pair_tx_id &&
            !(x.type === 'income' && isRefundRow(x)) &&
            !x.reason?.startsWith('Revolut:') &&
            !x.reason?.startsWith('na Twój rachunek') &&
            !x.reason?.startsWith('z Twojego rachunku'),
        )
        .map(({ i }) => i),
    [rows],
  )
  const ruleRows = useMemo(
    () =>
      ruleEligible.map((i) => {
        const r = rows[i]
        return {
          description: r.description,
          amount: r.amount,
          title: r.title,
          counterparty: r.counterparty,
          counterparty_account: r.counterparty_account,
          raw_type: r.raw_type ?? null,
          currency: r.currency,
        }
      }),
    [ruleEligible, rows],
  )

  /** Zapisana reguła od razu zmienia pasujące pozycje przeglądanego importu (także te, którym
   * wcześniej wybrałeś kategorię ręcznie) — przed zatwierdzeniem, z możliwością cofnięcia. */
  async function applyRuleToRows(rule: Rule) {
    try {
      const eligible = ruleEligible
      const { indices } = await api.ruleMatchRows(rule.id, ruleRows)
      const value = ruleTarget(rule)
      const catKind = rule.category_id ? categories.find((c) => c.id === rule.category_id)?.kind : null
      const reason = ruleReason(rule)
      // kategoria wydatku tylko dla obciążeń, wpływu — dla uznań
      const targets = indices.map((k) => eligible[k]).filter((i) => rows[i] && (!catKind || (catKind === 'expense') === rows[i].amount < 0))
      const before = rows
      const beforeMine = mine
      if (targets.length) {
        const set = new Set(targets)
        setRows((rs) =>
          rs.map((x, idx) => {
            if (!set.has(idx)) return x
            const next = { ...x, ...applyAssignment(x, value, reason) }
            if (rule.shop_id && (next.type === 'expense' || next.type === 'income')) next.shop_id = rule.shop_id
            return next
          }),
        )
        // to Twoja decyzja — przypisanie „z tego samego źródła” już ich nie nadpisze
        setMine((m) => new Set([...m, ...targets.map((i) => rows[i].hash)]))
        markEdited(targets.map((i) => rows[i].hash))
      }
      toast(
        targets.length
          ? `Reguła zapisana — zmieniono ${targets.length} ${plural(targets.length, 'pozycję', 'pozycje', 'pozycji')} tego importu.`
          : 'Reguła zapisana — w tym imporcie żadna pozycja do niej nie pasuje.',
        targets.length
          ? {
              label: 'Cofnij w imporcie',
              run: () => {
                setRows(before)
                setMine(beforeMine)
              },
            }
          : undefined,
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** Reguła zapamiętywana automatycznie jako szkic pełnego formularza. */
  function learnDraft(g: LearnGroup): Partial<Rule> {
    const d = learnEdit[g.key]
    if (d) return d as Partial<Rule>
    const [k, id] = g.value.split(':')
    return {
      pattern: (learnPattern[g.key] ?? g.pattern).trim(),
      field: g.field,
      direction: g.direction,
      category_id: k === 'c' && id ? Number(id) : null,
      savings_goal_id: k === 'g' && id ? Number(id) : null,
      mark_transfer: k === 't',
      transfer_account_id: k === 't' && id ? Number(id) : null,
      priority: 0,
    }
  }

  /** Poprawiona reguła zapamiętywana: zapis szkicu i nowe przypisanie dla pozycji z tego źródła. */
  function saveDraft(g: LearnGroup, d: RuleInput) {
    setLearnEdit((e) => ({ ...e, [g.key]: d }))
    setLearnOff((s) => {
      const n = new Set(s)
      n.delete(g.key)
      return n
    })
    const value = ruleTarget(d)
    const catKind = d.category_id ? categories.find((c) => c.id === d.category_id)?.kind : null
    const targets = rows
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => !x.removed && groupKey(x) === g.key && assignmentValue(x) === g.value && (!catKind || (catKind === 'expense') === x.amount < 0))
      .map(({ i }) => i)
    if (value && (value !== g.value || d.shop_id)) {
      const set = new Set(targets)
      setRows((rs) =>
        rs.map((x, idx) => {
          if (!set.has(idx)) return x
          const next = value !== g.value ? { ...x, ...applyAssignment(x, value, MINE) } : { ...x }
          if (d.shop_id && (next.type === 'expense' || next.type === 'income')) next.shop_id = d.shop_id
          return next
        }),
      )
      setMine((m) => new Set([...m, ...targets.map((i) => rows[i].hash)]))
      markEdited(targets.map((i) => rows[i].hash))
    }
    toast(`Reguła poprawiona — zapiszę ją przy zatwierdzeniu importu${value !== g.value && targets.length ? ` (zmieniono ${targets.length} ${plural(targets.length, 'pozycję', 'pozycje', 'pozycji')})` : ''}.`)
  }

  async function removeCreated(rule: Rule) {
    if (!confirm(`Usunąć regułę „${rule.pattern}”? Pozycje tego importu zostaną z obecnym przypisaniem.`)) return
    try {
      await api.deleteRule(rule.id)
      setCreatedRules((rs) => rs.filter((r) => r.id !== rule.id))
      toast('Usunięto regułę')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function recompute(nextAccounts: (number | null)[]) {
    setBusy(true)
    setError(null)
    try {
      const p = await api.importPreview(files, bank, nextAccounts)
      const keep = new Map(rows.filter((r) => edited.has(r.hash)).map((r) => [r.hash, r]))
      setPreview(p)
      setRows(
        p.rows.map((r) => {
          const old = keep.get(r.hash)
          if (!old) return r
          const merged: Row = { ...r }
          for (const k of EDITABLE) (merged as unknown as Record<string, unknown>)[k] = old[k]
          return merged
        }),
      )
      setAccountIds(p.files.map((f, i) => f.account_id ?? nextAccounts[i] ?? null))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // --- reguły, których aplikacja się nauczy (uzupełniane na bieżąco)
  const learnGroups = useMemo<LearnGroup[]>(() => {
    const map = new Map<string, Row[]>()
    for (const r of rows) {
      if (r.removed || !r.include) continue
      const k = groupKey(r)
      if (!k) continue
      ;(map.get(k) ?? map.set(k, []).get(k)!).push(r)
    }
    const out: LearnGroup[] = []
    for (const [key, list] of map) {
      const chosen = list.filter((r) => mine.has(r.hash))
      const rep = chosen[chosen.length - 1] ?? list[0]
      const value = assignmentValue(rep)
      if (!value) continue
      const byManualRule = list.some((r) => r.reason?.startsWith('reguła'))
      const byLearned = list.some((r) => r.reason?.startsWith('zapamiętane'))
      if (!chosen.length && list.some((r) => knownReason(r.reason))) continue
      out.push({
        key,
        field: rep.learn_field!,
        pattern: rep.learn_pattern!,
        direction: rep.amount < 0 ? 'expense' : 'income',
        count: list.length,
        value,
        conflict: byManualRule && chosen.length > 0,
        change: byLearned && chosen.length > 0,
      })
    }
    // źródła objęte regułą dodaną w tym imporcie — ta reguła jest już na liście wyżej
    const created = new Set(createdRules.map(ruleReason))
    return out.filter((g) => !(g.conflict && (map.get(g.key) ?? []).every((r) => !r.reason?.startsWith('reguła') || created.has(r.reason)))).sort((a, b) => b.count - a.count)
  }, [rows, mine, createdRules])
  const activeLearn = learnGroups.filter((g) => !g.conflict && !learnOff.has(g.key))

  function targetLabel(value: string, amount: number) {
    const [k, id] = value.split(':')
    if (k === 't') return `⇄ przelew własny${id ? ` — ${accounts.find((a) => a.id === Number(id))?.name ?? ''}` : ''}`
    if (k === 'g') return `◎ ${goals.find((g) => g.id === Number(id))?.name ?? 'oszczędności'}`
    const c = categories.find((x) => x.id === Number(id))
    return c ? `${c.icon ?? '●'} ${c.name}` : amount < 0 ? 'wydatek' : 'wpływ'
  }

  /** Dokąd trafi wiersz wyciągu wielowalutowego: subkonto albo nowe subkonto w walucie wiersza. */
  function subaccountLabel(r: ImportRow): string | null {
    if (r.account_id) return `→ ${accounts.find((a) => a.id === r.account_id)?.name ?? 'rachunek'}`
    const fileAcc = accounts.find((a) => a.id === accountIds[r.file_index])
    if (!fileAcc) return null
    if (fileAcc.is_group || (fileAcc.currency || 'PLN') !== r.currency) return `→ nowy rachunek ${r.currency}`
    // wyciąg wielowalutowy na zwykłe konto: konto stanie się folderem, ta waluta trafi do subkonta
    if ((preview.files[r.file_index]?.missing_subaccounts?.length ?? 0) > 0 && fileAcc.parent_id === null) return `→ ${fileAcc.name} ${r.currency}`
    return null
  }

  async function commit() {
    setBusy(true)
    setError(null)
    try {
      const payloadRows = rows.filter((r) => !r.removed).map(({ removed: _r, ...rest }) => rest)
      const rules: LearnRule[] = activeLearn.map((g) => {
        const d = learnEdit[g.key]
        if (d) {
          return {
            field: d.field,
            pattern: d.pattern.trim(),
            direction: d.direction,
            category_id: d.category_id,
            savings_goal_id: d.savings_goal_id,
            mark_transfer: d.mark_transfer,
            transfer_account_id: d.transfer_account_id,
            edited: true,
            extra_patterns: d.extra_patterns ?? [],
            exclude_pattern: d.exclude_pattern ?? null,
            priority: d.priority ?? 0,
            shop_id: d.shop_id ?? null,
            shop_name: d.shop_name ?? null,
            mark_recurring: !!d.mark_recurring,
          }
        }
        const [k, id] = g.value.split(':')
        return {
          field: g.field,
          pattern: (learnPattern[g.key] ?? g.pattern).trim(),
          direction: g.direction,
          category_id: k === 'c' ? Number(id) : null,
          savings_goal_id: k === 'g' ? Number(id) : null,
          mark_transfer: k === 't',
          transfer_account_id: k === 't' && id ? Number(id) : null,
        }
      })
      const res = await api.importCommit(
        preview.files.map((f, i) => ({ filename: f.filename, bank: f.bank ?? 'ipko', account_id: accountIds[i] })),
        payloadRows,
        rules.filter((r) => r.pattern.length >= 2),
      )
      onDone(res)
    } catch (e) {
      setError((e as Error).message)
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  // --- liczniki i filtrowanie
  const live = rows.filter((r) => !r.removed)
  const toImport = live.filter((r) => r.include)
  const plain = toImport.filter((r) => r.type === 'expense' || r.type === 'income')
  // sumy w złotych (waluty obce wg bieżącego kursu)
  const pln = (r: ImportRow) => r.amount_pln ?? r.amount
  const sums = {
    expense: plain.filter((r) => r.amount < 0).reduce((s, r) => s + pln(r), 0),
    income: plain.filter((r) => r.amount > 0).reduce((s, r) => s + pln(r), 0),
    saving: toImport.filter((r) => isSaving(r.type)).reduce((s, r) => s - pln(r), 0),
    transfers: toImport.filter((r) => isTransfer(r.type)).length,
  }
  // zwrot nie potrzebuje kategorii
  const isUncat = (r: Row) => (r.type === 'expense' || r.type === 'income') && !r.category_id && !(r.type === 'income' && isRefundRow(r))
  // ukryte duplikaty nie liczą się w pozostałych zakładkach
  const shownLive = hideDup ? live.filter((r) => !r.duplicate) : live
  const counts: Record<Tab, number> = {
    all: shownLive.length,
    uncat: shownLive.filter((r) => isUncat(r) && r.include).length,
    dup: live.filter((r) => r.duplicate).length,
    special: shownLive.filter((r) => isTransfer(r.type) || isSaving(r.type)).length,
    removed: rows.length - live.length,
  }
  // duplikaty (kwota + dzień + konto) i podobne — decyzja w oknie zatwierdzenia; duplikaty na początku
  const decide = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.removed && r.duplicate)
    .sort((a, b) => Number(b.r.duplicate === 'exact') - Number(a.r.duplicate === 'exact'))
  const skippedDup = live.filter((r) => r.duplicate && !r.include).length

  const visible = useMemo(() => {
    const needle = q.trim()
    return rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => {
        if (tab === 'removed') return r.removed
        if (r.removed) return false
        if (hideDup && tab !== 'dup' && r.duplicate) return false
        if (tab === 'uncat' && !(isUncat(r) && r.include) && !pinned.has(r.hash)) return false
        if (tab === 'dup' && !r.duplicate) return false
        if (tab === 'special' && !(isTransfer(r.type) || isSaving(r.type))) return false
        if (needle && !fuzzyMatch(needle, r.description, r.counterparty, r.title, r.note)) return false
        return true
      })
  }, [rows, tab, q, pinned, hideDup])
  const visIdx = visible.map((v) => v.i)
  const expCats = categories.filter((c) => c.kind === 'expense')
  const incCats = categories.filter((c) => c.kind === 'income')
  const multi = preview.files.length > 1

  function options(r: Row) {
    const kind = r.amount < 0 ? 'expense' : 'income'
    return (
      <>
        <option value="">{r.type === 'income' && isRefundRow(r) ? '↩ zwrot (bez kategorii)' : '— bez kategorii —'}</option>
        <option value="new">＋ Nowa kategoria…</option>
        <optgroup label={kind === 'expense' ? 'Wydatki' : 'Wpływy'}>
          {(kind === 'expense' ? expCats : incCats).map((c) => (
            <option key={c.id} value={`c:${c.id}`}>
              {c.icon ? `${c.icon} ` : ''}
              {c.name}
            </option>
          ))}
        </optgroup>
        <optgroup label={kind === 'expense' ? 'Odkładam na cel' : 'Wypłata z oszczędności'}>
          {goals
            .filter((g) => !g.archived)
            .map((g) => (
              <option key={g.id} value={`g:${g.id}`}>
                ◎ {g.name}
              </option>
            ))}
        </optgroup>
        <TransferOptions accounts={accounts} exclude={accountIds[r.file_index]} prefix={r.amount < 0 ? '⇄ na' : '⇄ z'} />
      </>
    )
  }

  function dupInfo(r: Row) {
    if (!r.duplicate || !r.duplicate_of) return null
    const m = r.duplicate_of
    const where = m.source === 'file' ? `w pliku „${m.filename}”` : 'w bazie'
    const label =
      r.duplicate === 'exact'
        ? `Duplikat — ta sama kwota, dzień i rachunek ${where}${r.include ? ' (dodasz mimo to)' : ' — pominięty, zaznacz, żeby dodać'}`
        : `Podobna transakcja ${where} — ${r.include ? 'zostanie dodana' : 'pominięta'}`
    return (
      <div className="dup-info">
        <span className="dup-label">{label}</span>
        <span className="dup-match">
          ↳ {fmtDate(m.date)} · {m.description || '(brak opisu)'} · {money(m.amount)}
          {m.category_name ? ` · ${m.category_name}` : ''}
        </span>
        {r.duplicate_reason && <span className="dup-match">({r.duplicate_reason})</span>}
      </div>
    )
  }

  const actions = (i: number, r: Row, cls = '') =>
    tab === 'removed' ? (
      <div className={`rv-actions ${cls}`}>
        <button className="btn btn-text btn-sm" onClick={() => patch(i, { removed: false })}>
          Przywróć
        </button>
      </div>
    ) : (
      <div className={`rv-actions ${cls}`}>
        <button className="icon-btn" title="Notatka" aria-label="Notatka" onClick={() => setNoteOpen((s) => new Set(s).add(r.hash))}>
          ✎
        </button>
        <button className="icon-btn" title="Utwórz regułę z tego wpisu" aria-label="Utwórz regułę" onClick={() => setRuleFor(ruleFromRow(r))}>
          ⚙
        </button>
      </div>
    )

  return (
    <div className="review-overlay" role="dialog" aria-modal="true" aria-label="Sprawdź import">
      <header className="review-head">
        <button className="icon-btn" onClick={() => close()} aria-label="Zamknij">
          ✕
        </button>
        <div style={{ minWidth: 0 }}>
          <h2>Sprawdź import</h2>
          <div className="small muted truncate">
            Popraw opisy i kategorie — nic nie zapisze się bez Twojego zatwierdzenia.
          </div>
        </div>
      </header>

      <div className="review-scroll">
        <div className="review-inner">
          <div className="review-files">
            {preview.files.map((f, i) => (
              <div key={i} className={`file-chip ${f.error ? 'file-error' : ''}`}>
                <div className="file-name" title={f.filename}>
                  {f.filename}
                </div>
                {f.error ? (
                  <div className="neg small">{f.error}</div>
                ) : (
                  <>
                    <div className="small muted">
                      {f.bank_label} · {f.row_count} operacji
                      {f.date_from && ` · ${fmtDate(f.date_from)}–${fmtDate(f.date_to)}`}
                    </div>
                    <AccountSelect
                      allowGroups
                      className={accountIds[i] ? '' : 'needs-account'}
                      value={accountIds[i] ?? null}
                      disabled={busy}
                      emptyLabel="Wybierz rachunek, z którego jest wyciąg…"
                      suggest={{ bank: f.bank, number: f.statement_account }}
                      onChange={(id) => {
                        const next = [...accountIds]
                        next[i] = id
                        recompute(next)
                      }}
                    />
                    {!accountIds[i] && <div className="tiny muted">Bez rachunku transakcje nie wejdą do sald i statystyk rachunków.</div>}
                    {f.closing_balance !== null && f.closing_balance !== undefined && (
                      <div className="tiny muted">
                        Saldo po ostatniej operacji ({fmtDate(f.date_to)}):{' '}
                        <strong>{money(f.closing_balance, accounts.find((a) => a.id === accountIds[i])?.currency ?? 'PLN')}</strong>
                      </div>
                    )}
                    {f.account_detected && <span className="badge badge-accent">rachunek rozpoznany z pliku</span>}
                    {(f.currencies?.length ?? 0) > 1 && (
                      <div className="tiny muted">
                        Waluty: {f.currencies!.join(', ')} — operacje trafią do rachunków w swoich walutach
                        {f.missing_subaccounts?.length ? ` (nowe: ${f.missing_subaccounts.join(', ')})` : ''}.
                      </div>
                    )}
                    {f.existing_in_range > 0 && (
                      <div className="small warn-text">
                        Okres pokrywa się z {f.existing_in_range} transakcjami w bazie — duplikaty są oznaczone.
                      </div>
                    )}
                    {f.warnings.map((w) => (
                      <div key={w} className="small muted">
                        {w}
                      </div>
                    ))}
                  </>
                )}
              </div>
            ))}
          </div>
          <ErrorBox error={error} />

          <div className="review-body">
            <div className="review-list">
              <div className="rv-toolbar">
                <div className="chips">
                  {(
                    [
                      ['all', 'Wszystkie'],
                      ['uncat', 'Bez kategorii'],
                      ['dup', 'Duplikaty'],
                      ['special', 'Przelewy i oszczędności'],
                      ['removed', 'Usunięte'],
                    ] as [Tab, string][]
                  )
                    .filter(([t]) => t === 'all' || counts[t] > 0)
                    .map(([t, label]) => (
                      <button key={t} className={`chip-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                        {label} <span className="count">{counts[t]}</span>
                      </button>
                    ))}
                  {counts.dup > 0 && tab !== 'dup' && (
                    <button
                      className={`chip-btn chip-toggle ${hideDup ? 'active' : ''}`}
                      aria-pressed={hideDup}
                      onClick={() => setHideDup(!hideDup)}
                      title="Chowa duplikaty i podobne na liście — to, czy zostaną dodane, nadal widać w zakładce Duplikaty"
                    >
                      🙈 {hideDup ? `Duplikaty ukryte (${counts.dup})` : 'Ukryj duplikaty'}
                    </button>
                  )}
                </div>
                <div className="rv-search-row">
                  <input placeholder="Szukaj…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minHeight: 40, borderRadius: 999 }} />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setRuleFor({ pattern: q.trim(), field: 'description', direction: 'any', category_id: null, savings_goal_id: null, mark_transfer: false, transfer_account_id: null })}
                    title="Nowa reguła — od razu poprawi pasujące pozycje tego importu"
                  >
                    ＋ Reguła
                  </button>
                </div>
                {tab !== 'removed' && visIdx.length > 1 && (
                  <div className="bulk">
                    <span className="small muted nowrap">Widoczne ({visIdx.length}):</span>
                    <select
                      value=""
                      onChange={(e) => {
                        const v = e.target.value
                        if (!v) return
                        const kind = v.startsWith('c:') ? categories.find((c) => `c:${c.id}` === v)?.kind : null
                        const targets = visIdx.filter((i) => !kind || (kind === 'expense') === rows[i].amount < 0)
                        patchMany(targets, (r) => applyAssignment(r, v, MINE))
                        setMine((m) => {
                          const n = new Set(m)
                          targets.forEach((i) => n.add(rows[i].hash))
                          return n
                        })
                      }}
                    >
                      <option value="">ustaw kategorię…</option>
                      <optgroup label="Wydatki">
                        {expCats.map((c) => (
                          <option key={c.id} value={`c:${c.id}`}>
                            {c.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Wpływy">
                        {incCats.map((c) => (
                          <option key={c.id} value={`c:${c.id}`}>
                            {c.name}
                          </option>
                        ))}
                      </optgroup>
                      <option value="t:">⇄ Przelew własny</option>
                    </select>
                    <button className="btn btn-ghost btn-sm" onClick={() => patchMany(visIdx.filter((i) => rows[i].duplicate !== 'exact' || tab === 'dup'), () => ({ include: true }))}>
                      Uwzględnij
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => patchMany(visIdx, () => ({ include: false }))}>
                      Pomiń
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => patchMany(visIdx, () => ({ removed: true }))}>
                      Usuń
                    </button>
                  </div>
                )}
              </div>

              {visible.length === 0 ? (
                <div className="empty">
                  <div className="empty-title">{tab === 'uncat' ? 'Wszystko ma kategorię 👌' : 'Brak pozycji'}</div>
                </div>
              ) : (
                visible.map(({ r, i }) => {
                  const exact = r.duplicate === 'exact'
                  const learned = r.reason === SAME_SOURCE || r.reason?.startsWith('zapamiętane')
                  return (
                    <div key={r.hash} className={`rv-row ${r.include ? '' : 'excluded'} ${r.duplicate ? 'dup' : ''}`}>
                      <div className="rv-check">
                        {tab !== 'removed' && (
                          <input
                            type="checkbox"
                            checked={r.include}
                            title={exact ? 'Duplikat — zaznacz, żeby dodać mimo to' : 'Uwzględnij'}
                            onChange={(e) => patch(i, { include: e.target.checked })}
                            aria-label="Uwzględnij"
                          />
                        )}
                      </div>
                      <div className="rv-main">
                        <div className="rv-date">
                          {fmtDate(r.date)}
                          {multi && ` · plik ${r.file_index + 1}`}
                        </div>
                        <input
                          className={`inline-edit ${edited.has(r.hash) ? 'edited' : ''}`}
                          value={r.description}
                          onChange={(e) => patch(i, { description: e.target.value })}
                          aria-label="Opis"
                        />
                        {r.title && r.counterparty && <div className="rv-sub">{r.title}</div>}
                        {(noteOpen.has(r.hash) || r.note) && (
                          <input className="note-edit" placeholder="Notatka…" value={r.note ?? ''} onChange={(e) => patch(i, { note: e.target.value || null })} />
                        )}
                        {dupInfo(r)}
                      </div>
                      <div className="rv-assign">
                        <div>
                          <select
                            value={assignmentValue(r)}
                            onChange={(e) => (e.target.value === 'new' ? setNewCatFor(i) : assign(i, e.target.value))}
                            aria-label="Kategoria"
                          >
                            {options(r)}
                          </select>
                          {r.type === 'income' && isRefundRow(r) ? (
                            <div className="reason refund-link">
                              ↩ zwrot do: {r.refund_of_label}{' '}
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => patch(i, { refund_of_id: null, refund_of_hash: null, refund_of_label: null, reason: null })}
                                title="To nie jest zwrot za ten wydatek"
                              >
                                odepnij
                              </button>
                            </div>
                          ) : (
                            r.reason && <div className={`reason ${learned ? 'learned' : ''}`}>{r.reason}</div>
                          )}
                        </div>
                        {actions(i, r, 'mobile-actions')}
                      </div>
                      <div className={`rv-amount ${isTransfer(r.type) ? 'trf' : isSaving(r.type) ? 'sav' : r.amount < 0 ? 'neg' : 'pos'}`}>
                        {money(r.amount, r.currency)}
                        {r.currency !== 'PLN' && r.amount_pln != null && <span className="amount-sub">≈ {money(r.amount_pln)}</span>}
                        {subaccountLabel(r) && <span className="rv-subacc">{subaccountLabel(r)}</span>}
                      </div>
                      {actions(i, r)}
                    </div>
                  )
                })
              )}
            </div>

            <details className="learn-panel" open={!mobile}>
              <summary>
                <span>🧠</span>
                <span>
                  <strong>Zapamiętam na przyszłość</strong>
                  <div className="small muted">
                    {activeLearn.length + createdRules.length
                      ? `${activeLearn.length + createdRules.length} ${plural(activeLearn.length + createdRules.length, 'reguła', 'reguły', 'reguł')}`
                      : 'przypisz kategorie, a reguły pojawią się tutaj'}
                  </div>
                </span>
                <span className="chev">▾</span>
              </summary>
              <div className="learn-body">
                <p className="small muted">
                  Kolejne transakcje z tych samych źródeł dostaną te kategorie automatycznie. Każdą regułę możesz poprawić (✎). Reguły znajdziesz potem w
                  Ustawieniach → Reguły.
                </p>
                {createdRules.length > 0 && (
                  <>
                    <div className="learn-sub">Dodane w tym imporcie</div>
                    {createdRules.map((r) => (
                      <div key={`r${r.id}`} className="learn-item learn-item-saved">
                        <span className="learn-saved-dot" title="Reguła jest już zapisana">✓</span>
                        <div style={{ minWidth: 0 }}>
                          <div className="learn-pattern-row">
                            <code className="truncate" title={[r.pattern, ...(r.extra_patterns ?? []).map((x) => x.pattern)].join(' · ')}>
                              {r.pattern}
                            </code>
                            {(r.extra_patterns?.length ?? 0) > 0 && <span className="badge">+{r.extra_patterns!.length}</span>}
                          </div>
                          <div className="learn-target">
                            <span className="muted">
                              {FIELD_LABEL[r.field]} · {r.direction === 'expense' ? 'wydatki' : r.direction === 'income' ? 'wpływy' : 'wszystkie'} →
                            </span>
                            <strong>{targetLabel(ruleTarget(r), r.direction === 'income' ? 1 : -1)}</strong>
                            {r.shop_name && <span className="badge">🏪 {r.shop_name}</span>}
                            {r.mark_recurring && <span className="badge badge-accent">↻ stały</span>}
                            <span className="badge badge-accent">zapisana</span>
                          </div>
                          <div className="learn-actions">
                            <button type="button" className="btn btn-text btn-sm" onClick={() => setRuleFor(r)}>
                              ✎ Edytuj
                            </button>
                            <button type="button" className="btn btn-text btn-sm" onClick={() => void removeCreated(r)}>
                              Usuń
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                    {learnGroups.length > 0 && <div className="learn-sub">Zapamiętam po zatwierdzeniu</div>}
                  </>
                )}
                {learnGroups.length === 0 && createdRules.length === 0 && (
                  <div className="small muted">Na razie nic nowego — wszystko rozpoznane wcześniejszymi regułami.</div>
                )}
                {learnGroups.map((g) => {
                  const off = g.conflict || learnOff.has(g.key)
                  const d = learnEdit[g.key]
                  return (
                    <div key={g.key} className={`learn-item ${off ? 'off' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!off}
                        disabled={g.conflict}
                        aria-label="Zapamiętaj"
                        onChange={(e) =>
                          setLearnOff((s) => {
                            const n = new Set(s)
                            if (e.target.checked) n.delete(g.key)
                            else n.add(g.key)
                            return n
                          })
                        }
                      />
                      <div style={{ minWidth: 0 }}>
                        {d ? (
                          <div className="learn-pattern-row">
                            <code className="truncate" title={[d.pattern, ...(d.extra_patterns ?? []).map((x) => x.pattern)].join(' · ')}>
                              {d.pattern}
                            </code>
                            {(d.extra_patterns?.length ?? 0) > 0 && <span className="badge">+{d.extra_patterns!.length}</span>}
                          </div>
                        ) : (
                          <input type="text" value={learnPattern[g.key] ?? g.pattern} onChange={(e) => setLearnPattern((p) => ({ ...p, [g.key]: e.target.value }))} aria-label="Wzorzec" />
                        )}
                        <div className="learn-target">
                          <span className="muted">
                            {FIELD_LABEL[d?.field ?? g.field]} · {(d?.direction ?? g.direction) === 'expense' ? 'wydatki' : (d?.direction ?? g.direction) === 'income' ? 'wpływy' : 'wszystkie'} →
                          </span>
                          <strong>{targetLabel(d ? ruleTarget(d) : g.value, g.direction === 'expense' ? -1 : 1)}</strong>
                          {(d?.shop_id || d?.shop_name) && (
                            <span className="badge">🏪 {d.shop_name ?? shops.find((x) => x.id === d.shop_id)?.name ?? 'sklep'}</span>
                          )}
                          <span className="badge">{g.count}×</span>
                          {g.change && <span className="badge badge-accent">zmiana</span>}
                          {d?.mark_recurring && <span className="badge badge-accent">↻ stały</span>}
                          {d && <span className="badge badge-accent">poprawiona</span>}
                        </div>
                        {g.conflict ? (
                          <div className="tiny warn-text" style={{ marginTop: 4 }}>Masz własną regułę dla tego źródła — zmień ją w Ustawieniach.</div>
                        ) : (
                          <div className="learn-actions">
                            <button type="button" className="btn btn-text btn-sm" onClick={() => setDraftKey(g.key)}>
                              ✎ Edytuj
                            </button>
                            {d && (
                              <button
                                type="button"
                                className="btn btn-text btn-sm"
                                onClick={() =>
                                  setLearnEdit((e) => {
                                    const n = { ...e }
                                    delete n[g.key]
                                    return n
                                  })
                                }
                              >
                                ↺ Cofnij poprawki
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </details>
          </div>
        </div>
      </div>

      {ruleFor && (
        <RuleForm
          title={ruleFor.id ? 'Edytuj regułę (zmiany zastosuję od razu w tym imporcie)' : 'Nowa reguła (zastosuję ją od razu w tym imporcie)'}
          initial={ruleFor}
          onClose={() => setRuleFor(null)}
          importRows={ruleRows}
          onSaved={(rule) => {
            setCreatedRules((rs) => (rs.some((r) => r.id === rule.id) ? rs.map((r) => (r.id === rule.id ? rule : r)) : [...rs, rule]))
            void applyRuleToRows(rule)
          }}
        />
      )}
      {draftKey &&
        (() => {
          const g = learnGroups.find((x) => x.key === draftKey)
          if (!g) return null
          return (
            <RuleForm
              title="Reguła do zapamiętania (zapiszę ją przy zatwierdzeniu importu)"
              initial={learnDraft(g)}
              onClose={() => setDraftKey(null)}
              importRows={ruleRows}
              onDraft={(d) => saveDraft(g, d)}
            />
          )
        })()}
      {newCatFor !== null && rows[newCatFor] && (
        <NewCategoryModal
          kind={rows[newCatFor].amount < 0 ? 'expense' : 'income'}
          onClose={() => setNewCatFor(null)}
          onCreated={(c) => assign(newCatFor, `c:${c.id}`)}
        />
      )}
      <footer className="review-foot">
        <div className="review-summary">
          <strong>Do dodania: {toImport.length}</strong>
          <span className="neg">{money(sums.expense)}</span>
          <span className="pos">+{money(sums.income)}</span>
          {sums.saving !== 0 && <span className="sav">◎ {money(sums.saving)}</span>}
          {sums.transfers > 0 && <span className="trf">⇄ {sums.transfers}</span>}
          {skippedDup > 0 && <span className="muted">duplikaty: {skippedDup}</span>}
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={() => close()}>
            Anuluj
          </button>
          <button className="btn btn-primary" disabled={busy || toImport.length === 0} onClick={() => setConfirming(true)}>
            Zatwierdź {toImport.length}
          </button>
        </div>
      </footer>

      {asking && (
        <CloseConfirm
          text="Porzucić import? Twoje poprawki (kategorie, opisy, pominięte pozycje) zostaną utracone — nic nie zostało jeszcze zapisane."
          onStay={() => setAsking(false)}
          onDiscard={() => {
            setAsking(false)
            onClose()
          }}
        />
      )}
      {confirming && (
        <Modal title="Dodać do bazy?" onClose={() => setConfirming(false)} dirty={false}>
          <div className="form">
            {decide.length > 0 && (
              <div className="decide">
                <div className="decide-head">
                  <div>
                    <strong>Duplikaty i podobne ({decide.length})</strong>
                    <div className="tiny muted">
                      Duplikaty (ta sama kwota, dzień i rachunek) domyślnie pomijamy, podobne — dodajemy. Każdą decyzję możesz zmienić.
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => patchMany(decide.map((d) => d.i), () => ({ include: true }))}>
                      Dodaj wszystkie
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => patchMany(decide.map((d) => d.i), () => ({ include: false }))}>
                      Pomiń wszystkie
                    </button>
                  </div>
                </div>
                <ul className="decide-list">
                  {decide.map(({ r, i }) => (
                    <li key={r.hash}>
                      <div className="decide-main">
                        <div className="dupe-line">
                          <span className={`dup-badge ${r.duplicate === 'exact' ? 'exact' : ''}`}>{r.duplicate === 'exact' ? 'duplikat' : 'podobna'}</span>
                          <span className="tiny muted nowrap">{fmtDate(r.date)}</span>
                          <span className="truncate">{r.description}</span>
                          <span className={`amount small ${r.amount < 0 ? 'neg' : 'pos'}`}>{money(r.amount, r.currency)}</span>
                        </div>
                        {r.duplicate_of && (
                          <div className="tiny muted">
                            ↳ {r.duplicate_of.source === 'file' ? `w pliku „${r.duplicate_of.filename}”` : 'już jest'}: {fmtDate(r.duplicate_of.date)} ·{' '}
                            {r.duplicate_of.description || '(brak opisu)'}
                            {r.duplicate_of.account_name ? ` · ${r.duplicate_of.account_name}` : ''} — {r.duplicate_reason}
                          </div>
                        )}
                      </div>
                      <div className="segmented segmented-sm decide-toggle">
                        <button className={`seg ${r.include ? 'active' : ''}`} onClick={() => patch(i, { include: true })}>
                          Dodaj
                        </button>
                        <button className={`seg ${!r.include ? 'active' : ''}`} onClick={() => patch(i, { include: false })}>
                          Pomiń
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="list-rows" style={{ margin: 0 }}>
              <li className="list-row">
                <span className="list-main">Wydatki ({plain.filter((r) => r.amount < 0).length})</span>
                <span className="amount neg">{money(sums.expense)}</span>
              </li>
              <li className="list-row">
                <span className="list-main">Wpływy ({plain.filter((r) => r.amount > 0).length})</span>
                <span className="amount pos">{money(sums.income)}</span>
              </li>
              {toImport.some((r) => isSaving(r.type)) && (
                <li className="list-row">
                  <span className="list-main">Oszczędności ({toImport.filter((r) => isSaving(r.type)).length})</span>
                  <span className="amount sav">{money(sums.saving)}</span>
                </li>
              )}
              {sums.transfers > 0 && (
                <li className="list-row">
                  <span className="list-main">Przelewy własne — poza statystykami</span>
                  <span className="muted">{sums.transfers}</span>
                </li>
              )}
            </ul>
            <p className="small muted">
              Pominięte: {live.length - toImport.length} (duplikaty: {skippedDup}) · usunięte: {counts.removed}
              {counts.uncat > 0 && ` · bez kategorii: ${counts.uncat}`}
              {activeLearn.length > 0 && ` · zapamiętam ${activeLearn.length} ${plural(activeLearn.length, 'regułę', 'reguły', 'reguł')}`}
            </p>
            <p className="tiny muted">
              {preview.files
                .map((f, i) => ({ f, i }))
                .filter(({ f }) => !f.error)
                .map(({ f, i }) => `${f.filename} → ${accounts.find((a) => a.id === accountIds[i])?.name ?? 'bez rachunku'} (${BANK_LABEL[f.bank ?? ''] ?? f.bank})`)
                .join(' · ')}
            </p>
            <div className="sheet-actions">
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                Wróć
              </button>
              <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={commit} disabled={busy}>
                {busy ? 'Zapisywanie…' : `Dodaj ${toImport.length}`}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
