import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, type RowText } from '../api'
import { Amount, Empty, ErrorBox, Modal, shopLabel, useLoad } from '../components/ui'
import { useData } from '../context'
import { useProposals } from '../components/RuleProposals'
import { TransferOptions } from '../components/AccountOptions'
import { fmtDate, money, plural } from '../format'
import { fuzzyMatch } from '../fuzzy'
import { groupRules } from '../ruleGroups'
import type { Rule, RuleDirection, RuleField, RuleInput, RuleTest } from '../types'

const FIELDS: { id: RuleField; label: string; hint: string; example: string }[] = [
  { id: 'title', label: 'Tytuł operacji', hint: 'tytuł przelewu / opis operacji z wyciągu', example: 'WYPŁATA ZA OKRES *' },
  { id: 'counterparty', label: 'Kontrahent / źródło wpływu', hint: 'nadawca wpływu, odbiorca przelewu, nazwa sklepu', example: 'ACME SP. Z O.O.*' },
  { id: 'counterparty_account', label: 'Numer rachunku kontrahenta', hint: 'same cyfry, spacje są ignorowane', example: '*1234 5678 9012' },
  { id: 'description', label: 'Cały opis', hint: 'tytuł + kontrahent + typ operacji razem', example: 'biedronka' },
]

const FIELD_SHORT: Record<RuleField, string> = {
  title: 'Tytuł',
  counterparty: 'Kontrahent',
  counterparty_account: 'Nr rachunku',
  description: 'Opis',
}

const DIRECTION_LABEL: Record<RuleDirection, string> = { any: 'wszystkie', expense: 'obciążenia', income: 'wpływy' }

const EMPTY: RuleInput = {
  pattern: '',
  field: 'description',
  direction: 'any',
  category_id: null,
  savings_goal_id: null,
  mark_transfer: false,
  transfer_account_id: null,
  priority: 0,
}

function targetValue(r: RuleInput): string {
  if (r.mark_transfer) return `t:${r.transfer_account_id ?? ''}`
  if (r.savings_goal_id) return `g:${r.savings_goal_id}`
  if (r.category_id) return `c:${r.category_id}`
  return ''
}

export function RuleForm({
  initial,
  onClose,
  onSaved,
  title,
  importRows,
  onDraft,
}: {
  initial: Partial<Rule>
  onClose: () => void
  onSaved?: (rule: Rule) => void
  title?: string
  /** wiersze przeglądanego importu — podgląd, które z nich zmieni reguła */
  importRows?: RowText[]
  /** szkic bez zapisu (reguła zapamiętywana przy imporcie) — dostaje dane formularza zamiast zapisu na serwerze */
  onDraft?: (rule: RuleInput) => void
}) {
  const { categories, goals, accounts, shops, bump, refresh } = useData()
  const [rule, setRule] = useState<RuleInput>({ ...EMPTY, ...initial })
  // sklep reguły: wybór z listy albo nowy (wpisany); puste = reguła bez sklepu
  const [shopSel, setShopSel] = useState<string>(initial.shop_id ? String(initial.shop_id) : initial.shop_name ? 'new' : '')
  const [shopName, setShopName] = useState(initial.shop_id ? '' : (initial.shop_name ?? ''))
  const [test, setTest] = useState<RuleTest | null>(null)
  const [error, setError] = useState<string | null>(null)
  // wzorce reguły: pierwszy to wzorzec główny, kolejne — dodatkowe (każdy z własnym polem)
  const [pats, setPats] = useState<{ pattern: string; field: RuleField }[]>(() => [
    { pattern: initial.pattern ?? '', field: initial.field ?? EMPTY.field },
    ...(initial.extra_patterns ?? []),
  ])
  const set = (patch: Partial<RuleInput>) => setRule((r) => ({ ...r, ...patch }))
  const setPat = (i: number, patch: Partial<{ pattern: string; field: RuleField }>) => setPats((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const hasWildcard = pats.some((p) => /[*?]/.test(p.pattern))
  const target = targetValue(rule)
  const usable = (p: string) => !!p.trim() && !/^[*?\s]+$/.test(p)
  // wzorce do zapisu: pierwszy niepusty jest główny
  const filled = pats.filter((p) => p.pattern.trim())
  // wydatek stały tylko dla reguły z kategorią wydatków
  const recurringOk = !!rule.category_id && categories.find((c) => c.id === rule.category_id)?.kind === 'expense' && rule.direction !== 'income'
  const body: RuleInput = {
    ...rule,
    mark_recurring: recurringOk && !!rule.mark_recurring,
    pattern: filled[0]?.pattern ?? '',
    field: filled[0]?.field ?? pats[0].field,
    extra_patterns: filled.slice(1),
  }
  const patsKey = JSON.stringify(filled)

  // podgląd na żywo w oknie importu: które pozycje tego importu pasują
  const [importHits, setImportHits] = useState<number[] | null>(null)
  useEffect(() => {
    if (!importRows) return
    if (!filled.length || !filled.every((p) => usable(p.pattern))) {
      setImportHits(null)
      return
    }
    const t = setTimeout(() => {
      api
        .ruleProbeRows(body, importRows)
        .then((r) => setImportHits(r.indices))
        .catch(() => setImportHits(null))
    }, 250)
    return () => clearTimeout(t)
  }, [patsKey, rule.direction, rule.exclude_pattern, importRows]) // eslint-disable-line react-hooks/exhaustive-deps

  // podgląd na żywo: które istniejące transakcje pasują
  useEffect(() => {
    if (!filled.length || !filled.every((p) => usable(p.pattern))) {
      setTest(null)
      return
    }
    const t = setTimeout(() => {
      api
        .testRule(body)
        .then(setTest)
        .catch(() => setTest(null))
    }, 350)
    return () => clearTimeout(t)
  }, [patsKey, rule.direction, rule.exclude_pattern]) // eslint-disable-line react-hooks/exhaustive-deps

  function setTarget(v: string) {
    const [k, id] = v.split(':')
    set({
      category_id: k === 'c' ? Number(id) : null,
      savings_goal_id: k === 'g' ? Number(id) : null,
      mark_transfer: k === 't',
      transfer_account_id: k === 't' && id ? Number(id) : null,
    })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!target) return setError('Wybierz, co reguła ma przypisać')
    if (!filled.length) return setError('Wpisz przynajmniej jeden wzorzec')
    if (!filled.every((p) => usable(p.pattern))) return setError('Wzorzec nie może składać się wyłącznie z symboli wieloznacznych')
    try {
      // sklep po nazwie: istniejący albo nowy; puste pole = reguła bez sklepu
      const payload =
        shopSel === 'new'
          ? { ...body, shop_id: null, shop_name: shopName.trim() || null }
          : { ...body, shop_id: shopSel ? Number(shopSel) : null, shop_name: null }
      if (onDraft) {
        onDraft(payload)
        onClose()
        return
      }
      const saved = initial.id ? await api.updateRule(initial.id, payload) : await api.createRule(payload)
      await refresh()
      bump()
      onSaved?.(saved)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const expCats = categories.filter((c) => c.kind === 'expense')
  const incCats = categories.filter((c) => c.kind === 'income')

  return (
    <Modal title={title ?? (initial.id ? 'Edytuj regułę' : 'Nowa reguła')} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <label>
          Dotyczy
          <select value={rule.direction} onChange={(e) => set({ direction: e.target.value as RuleDirection })}>
            <option value="any">wydatków i wpływów</option>
            <option value="income">tylko wpływów</option>
            <option value="expense">tylko wydatków (obciążeń)</option>
          </select>
        </label>
        <div className="rule-patterns">
          <div className="label">
            {pats.length > 1 ? 'Wzorce' : 'Wzorzec'}
            {pats.length > 1 && <span className="muted small"> — wystarczy, że pasuje jeden</span>}
          </div>
          {pats.map((p, i) => {
            const f = FIELDS.find((x) => x.id === p.field)!
            return (
              <div key={i} className="rule-pattern-row">
                <select value={p.field} onChange={(e) => setPat(i, { field: e.target.value as RuleField })} aria-label={`Sprawdzaj pole (wzorzec ${i + 1})`} title={f.hint}>
                  {FIELDS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <input
                  value={p.pattern}
                  onChange={(e) => setPat(i, { pattern: e.target.value })}
                  placeholder={`np. ${f.example}`}
                  required={i === 0}
                  autoFocus={i === pats.length - 1}
                  className="mono"
                  aria-label={`Wzorzec ${i + 1}`}
                />
                {pats.length > 1 && (
                  <button type="button" className="icon-btn" aria-label={`Usuń wzorzec ${i + 1}`} onClick={() => setPats((ps) => ps.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </div>
            )
          })}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPats((ps) => [...ps, { pattern: '', field: ps[ps.length - 1]?.field ?? 'description' }])}>
            ＋ Kolejny wzorzec
          </button>
          <span className="muted small">
            Kilka wzorców = ta sama kategoria, sklep i kierunek dla różnych opisów (np. „biedronka” w opisie i „JMP S.A.” w kontrahencie).
          </span>
          <span className="muted small">
            {hasWildcard ? (
              <>
                Wzorzec musi pasować do <strong>całego</strong> pola: <code>*</code> = dowolny tekst, <code>?</code> = jeden znak.
                Np. <code>WYPŁATA ZA OKRES *</code> pasuje do „Wypłata za okres 10/2026”. Żeby szukać w środku tekstu, użyj{' '}
                <code>*tekst*</code>.
              </>
            ) : (
              <>
                Bez <code>*</code> wystarczy, że pole <strong>zawiera</strong> ten tekst. Z <code>*</code> wzorzec musi pasować do
                całego pola. Wielkość liter i polskie znaki nie mają znaczenia.
              </>
            )}
          </span>
        </div>
        {importRows && (
          <div className="rule-test rule-test-import">
            <div className="rule-test-head">
              <strong>W tym imporcie</strong>
              <span className="muted small">
                {importHits === null
                  ? 'wpisz wzorzec'
                  : importHits.length === 0
                    ? 'żadna pozycja importu nie pasuje'
                    : `po zapisaniu zmienię ${importHits.length} ${importHits.length === 1 ? 'pozycję' : importHits.length < 5 ? 'pozycje' : 'pozycji'}`}
              </span>
            </div>
            {importHits && importHits.length > 0 && (
              <table className="table compact">
                <tbody>
                  {importHits.slice(0, 8).map((i) => (
                    <tr key={i}>
                      <td className="truncate" title={importRows[i].description}>
                        {importRows[i].description}
                      </td>
                      <td className="num">{money(importRows[i].amount, importRows[i].currency)}</td>
                    </tr>
                  ))}
                  {importHits.length > 8 && (
                    <tr>
                      <td colSpan={2} className="muted small">
                        …i {importHits.length - 8} więcej
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}
        <label>
          Wyjątek <span className="muted">(opcjonalnie)</span>
          <input
            value={rule.exclude_pattern ?? ''}
            onChange={(e) => set({ exclude_pattern: e.target.value || null })}
            placeholder="np. *APTEKA* — reguła nie zadziała dla takich transakcji"
            className="mono"
          />
          <span className="field-hint">Pomiń transakcje, w których to samo pole pasuje do tego wzorca.</span>
        </label>
        {initial.id && (initial.excluded_count ?? 0) > 0 && (
          <div className="row small">
            <span className="muted">
              Wyjątki dla pojedynczych transakcji: {initial.excluded_count}
            </span>
            <button
              type="button"
              className="btn btn-text btn-sm"
              onClick={async () => {
                await api.clearRuleExceptions(initial.id!)
                bump()
                onClose()
              }}
            >
              Wyczyść
            </button>
          </div>
        )}
        <div className="grid-2">
          <label>
            Przypisz
            <select value={target} onChange={(e) => setTarget(e.target.value)} required>
              <option value="">— wybierz —</option>
              {rule.direction !== 'income' && (
                <optgroup label="Kategoria wydatków">
                  {expCats.map((c) => (
                    <option key={c.id} value={`c:${c.id}`}>
                      {c.icon ? `${c.icon} ` : ''}
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {rule.direction !== 'expense' && (
                <optgroup label="Kategoria wpływów">
                  {incCats.map((c) => (
                    <option key={c.id} value={`c:${c.id}`}>
                      {c.icon ? `${c.icon} ` : ''}
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Oszczędności">
                {goals.map((g) => (
                  <option key={g.id} value={`g:${g.id}`}>
                    ◎ {g.name}
                  </option>
                ))}
              </optgroup>
              <TransferOptions accounts={accounts} />
            </select>
          </label>
          <label>
            Priorytet
            <input type="number" value={rule.priority} onChange={(e) => set({ priority: Number(e.target.value) || 0 })} />
            <span className="muted small">Wyższy sprawdzany wcześniej; wygrywa pierwsza pasująca reguła.</span>
          </label>
        </div>

        <label className={`rule-recurring ${recurringOk ? '' : 'disabled'}`}>
          <input type="checkbox" checked={recurringOk && !!rule.mark_recurring} disabled={!recurringOk} onChange={(e) => set({ mark_recurring: e.target.checked })} />
          <span>
            <span className="strong">↻ Oznacz jako wydatek stały</span>
            <span className="field-hint">
              {recurringOk
                ? 'Pasujące wydatki — wcześniejsze i z przyszłych importów — będą jednym wydatkiem stałym (znacznik „↻ stała”, Statystyki → Wydatki stałe).'
                : 'Dostępne, gdy reguła przypisuje kategorię wydatków.'}
            </span>
          </span>
        </label>

        <label>
          Sklep <span className="muted">(opcjonalnie)</span>
          <select value={shopSel} onChange={(e) => setShopSel(e.target.value)} aria-label="Sklep reguły">
            <option value="">— reguła bez sklepu —</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {shopLabel(s)}
              </option>
            ))}
            <option value="new">＋ Nowy sklep…</option>
          </select>
          {shopSel === 'new' && (
            <input value={shopName} onChange={(e) => setShopName(e.target.value)} maxLength={80} placeholder="Nazwa nowego sklepu, np. Biedronka" autoFocus aria-label="Nazwa sklepu reguły" style={{ marginTop: 6 }} />
          )}
          <span className="field-hint">
            Pasujące wydatki i wpływy dostaną ten sklep — w Statystykach kategorii zobaczysz najczęściej wybierane sklepy. Nowa nazwa doda sklep do listy.
          </span>
        </label>

        <div className="rule-test">
          <div className="rule-test-head">
            <strong>{importRows ? 'Już zapisane transakcje' : 'Podgląd dopasowań'}</strong>
            <span className="muted small">
              {test === null ? 'wpisz wzorzec' : test.count === 0 ? 'żadna z istniejących transakcji nie pasuje' : `pasuje ${test.count} istniejących transakcji`}
            </span>
          </div>
          {test && test.samples.length > 0 && (
            <table className="table compact">
              <tbody>
                {test.samples.map((s) => (
                  <tr key={s.id}>
                    <td className="nowrap muted">{fmtDate(s.date)}</td>
                    <td className="truncate" title={s.description}>
                      {s.description}
                    </td>
                    <td className="muted small nowrap">{s.category_name ?? ''}</td>
                    <td className="num">
                      <Amount value={s.amount} type={s.type} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <ErrorBox error={error} />
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn btn-primary">{onDraft ? 'Gotowe' : 'Zapisz regułę'}</button>
        </div>
      </form>
    </Modal>
  )
}

function Suggestions() {
  const { version, bump } = useData()
  const proposals = useProposals()
  const sug = useLoad(() => api.ruleSuggestions(), [version])
  const [busy, setBusy] = useState<string | null>(null)
  if (!sug.data?.length) return null
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>💡 Propozycje nowych reguł</h3>
          <div className="sub">Na podstawie kategorii, które nadałeś kilka razy temu samemu źródłu.</div>
        </div>
      </div>
      <ul className="list-rows">
        {sug.data.map((s) => (
          <li key={s.key} className="list-row">
            <div className="list-main">
              <div className="row" style={{ gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                <code>{s.pattern}</code>
                <span className="muted">→</span>
                <strong className="small">{s.target_label}</strong>
              </div>
              <div className="list-sub">
                {s.based_on}× przypisane{s.would_fill ? ` · uzupełni ${s.would_fill} bez kategorii` : ''} · np. {s.examples[0]}
              </div>
            </div>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy === s.key}
              onClick={async () => {
                setBusy(s.key)
                const r = await api.createRule({
                  pattern: s.pattern,
                  field: s.field,
                  direction: s.direction,
                  category_id: s.category_id,
                  savings_goal_id: null,
                  mark_transfer: false,
                  transfer_account_id: null,
                  priority: 0,
                  auto: true,
                })
                const p = await api.ruleMatches(r.id)
                proposals.show([p])
                bump()
                setBusy(null)
              }}
            >
              Dodaj
            </button>
            <button
              className="icon-btn"
              title="Ignoruj"
              aria-label="Ignoruj propozycję"
              onClick={async () => {
                await api.dismissSuggestion(s.key)
                sug.reload()
              }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function RulesSection() {
  return (
    <>
      <Suggestions />
      <RulesList />
    </>
  )
}

interface RuleFilters {
  q: string
  target: string
  field: '' | RuleField
  direction: '' | RuleDirection
  shop: string
  exceptions: boolean
  recurring: boolean
}

const NO_FILTERS: RuleFilters = { q: '', target: '', field: '', direction: '', shop: '', exceptions: false, recurring: false }

function RulesList() {
  const { version, bump, shops, categories, goals } = useData()
  const rules = useLoad(() => api.rules(), [version])
  const [editing, setEditing] = useState<Partial<Rule> | null>(null)
  const [show, setShow] = useState<'all' | 'auto' | 'mine'>('all')
  const [info, setInfo] = useState<string | null>(null)
  const [f, setF] = useState<RuleFilters>(NO_FILTERS)
  const setFilter = (patch: Partial<RuleFilters>) => setF((x) => ({ ...x, ...patch }))
  const filtered = f.target || f.field || f.direction || f.shop || f.exceptions || f.recurring || f.q.trim()
  const list = useMemo(
    () =>
      (rules.data ?? []).filter((r) => {
        if (show !== 'all' && (show === 'auto' ? !r.auto : r.auto)) return false
        if (f.target) {
          const t = r.mark_transfer ? 't' : r.savings_goal_id ? `g:${r.savings_goal_id}` : `c:${r.category_id}`
          if (f.target === 'g' ? !r.savings_goal_id : f.target !== t) return false
        }
        if (f.field && r.field !== f.field && !(r.extra_patterns ?? []).some((x) => x.field === f.field)) return false
        if (f.direction && r.direction !== f.direction) return false
        if (f.shop && (f.shop === 'none' ? r.shop_id : f.shop === 'any' ? !r.shop_id : String(r.shop_id) !== f.shop)) return false
        if (f.exceptions && !r.exclude_pattern && !r.excluded_count) return false
        if (f.recurring && !r.mark_recurring) return false
        if (
          f.q.trim() &&
          !fuzzyMatch(
            f.q,
            r.pattern,
            ...(r.extra_patterns ?? []).map((x) => x.pattern),
            r.exclude_pattern,
            r.category_name,
            r.savings_goal_name,
            r.transfer_account_name,
            r.shop_name,
          )
        )
          return false
        return true
      }),
    [rules.data, show, f],
  )
  const autoCount = (rules.data ?? []).filter((r) => r.auto).length
  // kategorie, które występują w regułach (do filtra „Przypisuje”)
  const used = new Set((rules.data ?? []).map((r) => r.category_id).filter(Boolean))
  const usedCats = categories.filter((c) => used.has(c.id))
  const usedShops = shops.filter((s) => (rules.data ?? []).some((r) => r.shop_id === s.id))
  // grupowanie podobnych reguł (próg podobieństwa wzorców; 0 = bez grupowania)
  const [threshold, setThreshold] = useState(() => {
    try {
      return Number(localStorage.getItem('finanse_rule_groups') ?? '0.6')
    } catch {
      return 0.6
    }
  })
  const groups = useMemo(() => (threshold > 0 ? groupRules(list, threshold) : []), [list, threshold])
  const targetKey = (r: Rule) => (r.mark_transfer ? `t${r.transfer_account_id}` : r.savings_goal_id ? `g${r.savings_goal_id}` : `c${r.category_id}`)

  function row(r: Rule, similarity?: number) {
    return (
      <li key={r.id} className="list-row clickable" onClick={() => setEditing(r)}>
        <div className="list-main">
          <div className="row" style={{ gap: 8, minWidth: 0 }}>
            <code className="truncate" title={[r.pattern, ...(r.extra_patterns ?? []).map((x) => x.pattern)].join(' · ')}>
              {r.pattern}
            </code>
            {(r.extra_patterns?.length ?? 0) > 0 && <span className="badge">+{r.extra_patterns!.length} {r.extra_patterns!.length === 1 ? 'wzorzec' : 'wzorce'}</span>}
            {r.auto ? <span className="badge badge-accent">zapamiętana{r.hits > 1 ? ` ×${r.hits}` : ''}</span> : <span className="badge">moja</span>}
            {r.mark_recurring && (
              <span className="badge badge-accent" title="Pasujące wydatki to wydatek stały">
                ↻ stały
              </span>
            )}
            {similarity !== undefined && similarity < 1 && (
              <span className="badge" title="Podobieństwo do pierwszej reguły w grupie">
                {Math.round(similarity * 100)}%
              </span>
            )}
          </div>
          <div className="list-sub">
            {FIELD_SHORT[r.field]} · {DIRECTION_LABEL[r.direction]}
            {r.exclude_pattern ? ` · oprócz ${r.exclude_pattern}` : ''}
            {r.excluded_count ? ` · wyjątki: ${r.excluded_count}` : ''}
            {r.shop_name ? ` · ${shopLabel({ name: r.shop_name, icon: shops.find((s) => s.id === r.shop_id)?.icon })}` : ''}
          </div>
        </div>
        {target(r)}
        <button
          className="icon-btn"
          aria-label="Usuń regułę"
          onClick={async (e) => {
            e.stopPropagation()
            if (!confirm(`Usunąć regułę „${r.pattern}”?`)) return
            await api.deleteRule(r.id)
            bump()
          }}
        >
          ✕
        </button>
      </li>
    )
  }

  function target(r: Rule) {
    if (r.mark_transfer) return <span className="chip chip-transfer">⇄ {r.transfer_account_name ?? 'przelew własny'}</span>
    if (r.savings_goal_name) return <span className="chip chip-saving">◎ {r.savings_goal_name}</span>
    return <span className="chip">{r.category_name}</span>
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Reguły kategoryzacji</h3>
          <div className="sub">
            Uzupełniają się same: gdy przypiszesz kategorię przy imporcie lub edycji, aplikacja zapamiętuje źródło (np. „BIEDRONKA*”).
          </div>
        </div>
        <div className="row">
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              const r = await api.applyRules()
              setInfo(`Przypisano ${r.updated} transakcji bez kategorii.`)
              bump()
            }}
          >
            Zastosuj do starych
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
            + Reguła
          </button>
        </div>
      </div>
      {info && <div className="alert alert-info" style={{ marginBottom: 12 }}>{info}</div>}
      <div className="rules-toolbar">
      <div className="chips">
        {(
          [
            ['all', `Wszystkie ${rules.data?.length ?? ''}`],
            ['auto', `Zapamiętane ${autoCount}`],
            ['mine', `Moje ${(rules.data?.length ?? 0) - autoCount}`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={`chip-btn ${show === id ? 'active' : ''}`} onClick={() => setShow(id)}>
            {label}
          </button>
        ))}
      </div>
        <label className="rules-group-select">
          <span className="small muted">Grupuj podobne</span>
          <select
            value={threshold}
            onChange={(e) => {
              setThreshold(Number(e.target.value))
              try {
                localStorage.setItem('finanse_rule_groups', e.target.value)
              } catch {
                /* ignorujemy */
              }
            }}
            aria-label="Grupuj podobne reguły"
          >
            <option value={0}>nie grupuj</option>
            {[0.5, 0.6, 0.7, 0.8, 0.9].map((t) => (
              <option key={t} value={t}>
                podobieństwo ≥ {Math.round(t * 100)}%
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="rules-filters">
        <input
          type="search"
          placeholder="Szukaj wzorca, kategorii, sklepu…"
          value={f.q}
          onChange={(e) => setFilter({ q: e.target.value })}
          aria-label="Szukaj reguł"
          className="rules-search"
        />
        <select value={f.target} onChange={(e) => setFilter({ target: e.target.value })} aria-label="Filtruj: co przypisuje">
          <option value="">Kategoria: każda</option>
          {usedCats.filter((c) => c.kind === 'expense').length > 0 && (
            <optgroup label="Kategorie wydatków">
              {usedCats
                .filter((c) => c.kind === 'expense')
                .map((c) => (
                  <option key={c.id} value={`c:${c.id}`}>
                    {c.icon ? `${c.icon} ` : ''}
                    {c.name}
                  </option>
                ))}
            </optgroup>
          )}
          {usedCats.filter((c) => c.kind === 'income').length > 0 && (
            <optgroup label="Kategorie wpływów">
              {usedCats
                .filter((c) => c.kind === 'income')
                .map((c) => (
                  <option key={c.id} value={`c:${c.id}`}>
                    {c.icon ? `${c.icon} ` : ''}
                    {c.name}
                  </option>
                ))}
            </optgroup>
          )}
          <optgroup label="Inne">
            <option value="g">◎ Cele oszczędnościowe</option>
            {goals
              .filter((g) => (rules.data ?? []).some((r) => r.savings_goal_id === g.id))
              .map((g) => (
                <option key={g.id} value={`g:${g.id}`}>
                  ◎ {g.name}
                </option>
              ))}
            <option value="t">⇄ Przelew własny</option>
          </optgroup>
        </select>
        <select value={f.field} onChange={(e) => setFilter({ field: e.target.value as RuleFilters['field'] })} aria-label="Filtruj: pole wzorca">
          <option value="">Pole: każde</option>
          {FIELDS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <select value={f.direction} onChange={(e) => setFilter({ direction: e.target.value as RuleFilters['direction'] })} aria-label="Filtruj: kierunek">
          <option value="">Kierunek: każdy</option>
          <option value="expense">tylko wydatki</option>
          <option value="income">tylko wpływy</option>
          <option value="any">wydatki i wpływy</option>
        </select>
        <select value={f.shop} onChange={(e) => setFilter({ shop: e.target.value })} aria-label="Filtruj: sklep">
          <option value="">Sklep: dowolny</option>
          <option value="any">ze sklepem</option>
          <option value="none">bez sklepu</option>
          {usedShops.map((s) => (
            <option key={s.id} value={s.id}>
              {shopLabel(s)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`chip-btn chip-toggle ${f.exceptions ? 'active' : ''}`}
          aria-pressed={f.exceptions}
          onClick={() => setFilter({ exceptions: !f.exceptions })}
        >
          Z wyjątkami
        </button>
        <button
          type="button"
          className={`chip-btn chip-toggle ${f.recurring ? 'active' : ''}`}
          aria-pressed={f.recurring}
          onClick={() => setFilter({ recurring: !f.recurring })}
        >
          ↻ Wydatki stałe
        </button>
      </div>
      {filtered && (
        <div className="row small muted" style={{ marginBottom: 8, justifyContent: 'space-between' }}>
          <span>
            Pasuje {list.length} z {rules.data?.length ?? 0}
          </span>
          <button type="button" className="btn btn-text btn-sm" onClick={() => setF(NO_FILTERS)}>
            Wyczyść filtry
          </button>
        </div>
      )}
      {list.length === 0 ? (
        filtered || show !== 'all' ? (
          <Empty title="Żadna reguła nie pasuje do filtrów" />
        ) : (
          <Empty title="Brak reguł">Przypisz kategorie przy imporcie — reguły pojawią się tu automatycznie.</Empty>
        )
      ) : threshold <= 0 ? (
        <ul className="list-rows">{list.map((r) => row(r))}</ul>
      ) : (
        <div className="rule-groups">
          {groups.filter((g) => g.items.length > 1).map((g) => {
            const mixed = new Set(g.items.map((x) => targetKey(x.rule))).size > 1
            return (
              <details key={g.items[0].rule.id} className="rule-group" open={g.items.length <= 6}>
                <summary>
                  <code className="truncate">{g.items[0].rule.pattern}</code>
                  <span className="badge badge-accent">
                    {g.items.length} {plural(g.items.length, 'reguła', 'reguły', 'reguł')}
                  </span>
                  <span className="small muted">min. {Math.round(g.minSimilarity * 100)}% podobieństwa</span>
                  {mixed && (
                    <span className="badge badge-warn" title="Podobne wzorce przypisują różne kategorie — sprawdź, czy to zamierzone">
                      różne kategorie
                    </span>
                  )}
                </summary>
                <ul className="list-rows">{g.items.map((x) => row(x.rule, x.similarity))}</ul>
              </details>
            )
          })}
          {groups.some((g) => g.items.length === 1) && (
            <>
              <div className="small muted rule-group-rest">Bez podobnych reguł</div>
              <ul className="list-rows">{groups.filter((g) => g.items.length === 1).map((g) => row(g.items[0].rule))}</ul>
            </>
          )}
        </div>
      )}
      <p className="tiny muted" style={{ marginTop: 12 }}>
        Wzorce: <code>BIEDRONKA*</code> — zaczyna się od „Biedronka”, <code>*ZUS*</code> — zawiera „ZUS”, <code>?</code> — jeden dowolny znak. Wielkość liter i polskie znaki nie mają znaczenia. Twoje reguły mają pierwszeństwo przed zapamiętanymi; edycja zapamiętanej reguły zamienia ją w Twoją.
      </p>
      {editing && <RuleForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
