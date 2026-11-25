import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { api } from '../api'
import { Empty, ErrorBox, Modal } from '../components/ui'
import { useData } from '../context'
import { BANK_LABEL, fmtDate, fmtIdentifier, fmtPhone, iso, money, orderAccounts, PALETTE, plural } from '../format'
import type { Account } from '../types'

const BANK_OPTIONS = [
  { id: 'ipko', label: 'PKO BP (iPKO)' },
  { id: 'ing', label: 'ING Bank Śląski' },
  { id: 'credit_agricole', label: 'Credit Agricole' },
  { id: 'millennium', label: 'Bank Millennium' },
  { id: 'revolut', label: 'Revolut' },
  { id: 'other', label: 'Inny bank' },
]

/** Lista wartości jako „pigułki” z polem do dopisywania kolejnych. */
function ListEditor({
  values,
  onChange,
  draft,
  onDraft,
  placeholder,
  format,
  inputMode,
  label,
}: {
  values: string[]
  onChange: (v: string[]) => void
  draft: string
  onDraft: (v: string) => void
  placeholder: string
  format: (v: string) => string
  inputMode: 'numeric' | 'tel'
  label: string
}) {
  const add = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    onDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add()
    } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1))
  }
  return (
    <div className="list-editor">
      {values.map((v) => (
        <span key={v} className="id-chip">
          {format(v)}
          <button type="button" aria-label={`Usuń ${format(v)}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <span className="list-editor-add">
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={add}
          placeholder={placeholder}
          inputMode={inputMode}
          aria-label={label}
        />
        {draft.trim() && (
          <button type="button" className="btn btn-ghost btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={add}>
            Dodaj
          </button>
        )}
      </span>
    </div>
  )
}

/** Rachunek (waluta, numery, telefony BLIK, saldo — zawsze w jakimś banku) albo bank (grupa rachunków z formatem wyciągu). */
type AccountKind = 'account' | 'group'
const KIND_OPTIONS: { id: AccountKind; label: string }[] = [
  { id: 'account', label: 'Rachunek' },
  { id: 'group', label: '🏦 Bank' },
]

export function AccountForm({ initial, onClose, onSaved }: { initial: Partial<Account>; onClose: () => void; onSaved?: (a: Account) => void }) {
  const { goals, accounts, currencies, bump } = useData()
  const [kind, setKind] = useState<AccountKind>(initial.is_group ? 'group' : 'account')
  const [name, setName] = useState(initial.name ?? '')
  const [bank, setBank] = useState(initial.bank ?? 'ipko')
  const [numbers, setNumbers] = useState<string[]>(() =>
    (initial.numbers ?? (initial.number ? [initial.number] : [])).map(fmtIdentifier).map((v) => v.replace(/^karta …/, '')),
  )
  const [numberDraft, setNumberDraft] = useState('')
  const [phones, setPhones] = useState<string[]>(() => (initial.phones ?? []).map(fmtPhone))
  const [phoneDraft, setPhoneDraft] = useState('')
  const [currency, setCurrency] = useState(initial.currency ?? 'PLN')
  // rachunek zawsze należy do banku (format wyciągu bierzemy z banku)
  const parents = accounts.filter((a) => a.is_group && a.id !== initial.id)
  const [parentId, setParentId] = useState(
    initial.parent_id ? String(initial.parent_id) : parents.length === 1 ? String(parents[0].id) : parents.length ? '' : 'new',
  )
  const [newBankName, setNewBankName] = useState('')
  const [product, setProduct] = useState(initial.product ?? '')
  const hasChildren = !!initial.id && accounts.some((a) => a.parent_id === initial.id)
  const parent = kind === 'account' && parentId && parentId !== 'new' ? accounts.find((a) => a.id === Number(parentId)) : undefined
  const creatingBank = kind === 'account' && parentId === 'new'
  const inBank = !!parent || creatingBank
  const bankFormat = parent?.bank ?? bank
  // waluty z zakładki „Waluty” (+ obecna waluta rachunku, gdyby ktoś usunął jej kurs)
  const currencyChoices = [...new Set([...currencies, ...(initial.currency ? [initial.currency] : [])])]
  const isGroup = kind === 'group'
  const [color, setColor] = useState(initial.color ?? '#0f766e')
  const [goalId, setGoalId] = useState(initial.savings_goal_id ? String(initial.savings_goal_id) : '')
  const [anchor, setAnchor] = useState(
    initial.balance_anchor !== null && initial.balance_anchor !== undefined ? String(initial.balance_anchor).replace('.', ',') : '',
  )
  const [anchorDate, setAnchorDate] = useState(() => initial.balance_anchor_date ?? iso(new Date()))
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const bal = anchor.trim() ? Number(anchor.replace(/\s/g, '').replace(',', '.')) : null
    if (bal !== null && !Number.isFinite(bal)) return setError('Nieprawidłowe saldo')
    const cur = currency.trim().toUpperCase()
    // to, co zostało wpisane, ale nie zatwierdzone Enterem, też się liczy
    const allNumbers = [...numbers, ...(numberDraft.trim() ? [numberDraft.trim()] : [])]
    const allPhones = [...phones, ...(phoneDraft.trim() ? [phoneDraft.trim()] : [])]
    if (!isGroup && !parentId) return setError('Wybierz bank, do którego należy rachunek')
    if (creatingBank && !newBankName.trim()) return setError('Podaj nazwę nowego banku')
    const data = isGroup
      ? { name, bank, color, archived: initial.archived ?? false, is_group: true }
      : {
          is_group: false,
          name,
          bank: bankFormat,
          numbers: allNumbers,
          phones: allPhones,
          currency: cur,
          parent_id: parent ? parent.id : null,
          product: bankFormat === 'revolut' && product.trim() ? product.trim() : null,
          color,
          savings_goal_id: goalId ? Number(goalId) : null,
          archived: initial.archived ?? false,
          balance_anchor: bal,
          balance_anchor_date: bal === null ? null : anchorDate || null,
        }
    try {
      if (creatingBank && !isGroup) {
        // nowy bank tworzymy razem z rachunkiem
        const b = await api.createAccount({ name: newBankName.trim(), bank, color, archived: false, is_group: true })
        Object.assign(data, { parent_id: b.id, bank: b.bank })
      }
      const saved = initial.id ? await api.updateAccount(initial.id, data) : await api.createAccount(data)
      bump()
      onSaved?.(saved)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Modal title={initial.id ? (initial.is_group ? 'Edytuj bank' : 'Edytuj rachunek') : 'Nowy rachunek lub bank'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {!initial.id && (
          <div className="segmented" role="radiogroup" aria-label="Rodzaj">
            {KIND_OPTIONS.map((k) => (
              <button
                type="button"
                key={k.id}
                role="radio"
                aria-checked={kind === k.id}
                className={`seg ${kind === k.id ? 'active' : ''}`}
                onClick={() => setKind(k.id)}
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
        <p className="hint" style={{ marginTop: initial.id ? 0 : -6 }}>
          {kind === 'group'
            ? 'Bank grupuje rachunki (np. Revolut → PLN, EUR, USD) i wyznacza format wyciągu: nie ma własnych operacji, numerów ani telefonów, a jego saldo to suma rachunków w złotych. Import wyciągu na bank sam rozdzieli operacje między rachunki według waluty.'
            : 'Rachunek należy do banku i ma własną walutę, numery rachunków i kart, telefony BLIK i saldo. Format wyciągu bierzemy z banku.'}
        </p>
        {hasChildren && <p className="hint">Ten bank ma rachunki — format wyciągu zmieni się dla nich wszystkich.</p>}
        {isGroup ? (
          <div className="grid-2">
            <label>
              Nazwa banku
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="np. Revolut" />
            </label>
            <label>
              Format wyciągu
              <select value={bank} onChange={(e) => setBank(e.target.value)}>
                {BANK_OPTIONS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="grid-2">
            <label>
              Bank
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Bank" required>
                <option value="" disabled>
                  — wybierz bank —
                </option>
                {parents.map((a) => (
                  <option key={a.id} value={a.id}>
                    🏦 {a.name} · {BANK_LABEL[a.bank] ?? a.bank}
                  </option>
                ))}
                <option value="new">＋ Nowy bank…</option>
              </select>
            </label>
            <label>
              Nazwa rachunku
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus={!creatingBank} placeholder="np. PKO osobiste" />
            </label>
          </div>
        )}
        {creatingBank && (
          <div className="grid-2 new-bank">
            <label>
              Nazwa nowego banku
              <input value={newBankName} onChange={(e) => setNewBankName(e.target.value)} placeholder="np. Revolut" autoFocus aria-label="Nazwa nowego banku" />
            </label>
            <label>
              Format wyciągu banku
              <select value={bank} onChange={(e) => setBank(e.target.value)} aria-label="Format wyciągu banku">
                {BANK_OPTIONS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {!isGroup && (
          <>
            <div className="grid-2">
              <label>
                Waluta
                <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Waluta rachunku">
                  {currencyChoices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              {bankFormat === 'revolut' && (
                <label>
                  Produkt <span className="muted">(opcjonalnie)</span>
                  <input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="np. Savings" maxLength={40} />
                </label>
              )}
            </div>
            <p className="hint">
              {inBank
                ? `Import wyciągu banku „${parent?.name ?? (newBankName || 'nowy bank')}” sam przypisze operacje w ${currency} do tego rachunku.${bankFormat === 'revolut' ? ' Produkt „Savings” oznacza skarbonkę Revolut.' : ''} Ten sam numer może mieć kilka rachunków w różnych walutach.`
                : ''}{' '}
              Brakuje waluty? Dodaj ją w Ustawienia → Waluty.
            </p>
            <div>
              <div className="label">
                Numery rachunków i kart <span className="muted">(opcjonalnie, ale potrzebne do rozpoznawania wyciągów i przelewów)</span>
              </div>
              <ListEditor
                values={numbers}
                onChange={setNumbers}
                draft={numberDraft}
                onDraft={setNumberDraft}
                placeholder={numbers.length ? 'kolejny numer…' : 'PL 12 3456 … albo 4 ostatnie cyfry karty'}
                format={(v) => (/^\d{4}$/.test(v.replace(/\s/g, '')) ? `karta …${v.replace(/\s/g, '')}` : v)}
                inputMode="numeric"
                label="Dodaj numer rachunku lub karty"
              />
            </div>
            <div>
              <div className="label">
                Telefony BLIK <span className="muted">(przelewy BLIK na ten numer trafiają na ten rachunek)</span>
              </div>
              <ListEditor
                values={phones}
                onChange={setPhones}
                draft={phoneDraft}
                onDraft={setPhoneDraft}
                placeholder={phones.length ? 'kolejny telefon…' : 'np. 600 100 200'}
                format={(v) => v}
                inputMode="tel"
                label="Dodaj numer telefonu"
              />
            </div>
            <label>
              Przelewy na ten rachunek to oszczędności? <span className="muted">(opcjonalnie)</span>
              <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
                <option value="">Nie — zwykły przelew własny</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    Tak — wpłata na cel „{g.name}”
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              Przelewy na numery i telefony z tej listy (oraz z nich) są w importach rozpoznawane jako przemieszczenia między Twoimi rachunkami i nie wliczają się
              do wydatków ani wpływów. Numer rachunku z wyciągu wskazuje też, do którego rachunku go zaimportować. Jeśli powiążesz rachunek z celem oszczędnościowym,
              przelew na nie zostanie zapisany jako wpłata na ten cel.
            </p>
            <div className="balance-box">
              <div className="label">Saldo</div>
              {initial.id && (
                <div className="small" style={{ marginBottom: 8 }}>
                  {initial.balance_known ? (
                    <>
                      Szacowane saldo dziś: <strong>{money(initial.balance, initial.currency)}</strong>
                      {initial.currency && initial.currency !== 'PLN' && initial.balance_pln !== null && (
                        <span className="muted"> ≈ {money(initial.balance_pln)}</span>
                      )}{' '}
                      <span className="muted">
                        ({initial.balance_source === 'manual' ? 'od salda wpisanego ręcznie' : 'z kolumny salda w wyciągu'} z {fmtDate(initial.balance_date)})
                      </span>
                    </>
                  ) : (
                    <span className="muted">Saldo nieznane — wyciągi tego rachunku nie miały kolumny salda.</span>
                  )}
                </div>
              )}
              <div className="grid-2">
                <label>
                  Aktualne saldo w {currency || 'PLN'} <span className="muted">(opcjonalnie)</span>
                  <span className="money-input">
                    <input inputMode="decimal" value={anchor} onChange={(e) => setAnchor(e.target.value)} placeholder="np. 4 250,00" aria-label={`Saldo w ${currency || 'PLN'}`} />
                    <span className="money-suffix" aria-hidden>
                      {currency || 'PLN'}
                    </span>
                  </span>
                  {currency && currency !== 'PLN' && <span className="field-hint strong">Kwota w walucie rachunku ({currency}), nie w złotych.</span>}
                </label>
                <label>
                  Stan na koniec dnia
                  <input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} disabled={!anchor.trim()} />
                </label>
              </div>
              <p className="hint">
                Zwykle nie trzeba nic wpisywać: saldo liczymy z kolumny „saldo po transakcji” w importowanych CSV i dodajemy późniejsze operacje. Wpisz saldo z
                aplikacji banku, jeśli wyciąg go nie zawiera albo wynik się nie zgadza — nowsze wyciągi i tak mają pierwszeństwo.
              </p>
            </div>
          </>
        )}
        <div>
          <div className="label">Kolor</div>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch ${c === color ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn btn-primary">Zapisz</button>
        </div>
      </form>
    </Modal>
  )
}

export function AccountsSection() {
  const { accounts, bump } = useData()
  const [editing, setEditing] = useState<Partial<Account> | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Rachunki i banki</h3>
          <div className="sub">Z numerami rachunków, kart i telefonami BLIK aplikacja rozpozna rachunek wyciągu i pominie przelewy między Twoimi rachunkami.</div>
        </div>
        <div className="row">
          {accounts.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                const r = await api.detectTransfers()
                const parts = [
                  r.updated ? `oznaczono ${r.updated} przelewów własnych` : '',
                  r.paired ? `połączono ${r.paired} ${r.paired === 1 ? 'parę' : 'par'} (np. Topup z wydatkiem w innym banku)` : '',
                ].filter(Boolean)
                setInfo(parts.length ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : 'Nie znaleziono nowych przelewów własnych.')
                bump()
              }}
            >
              Wykryj przelewy w historii
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
            + Rachunek
          </button>
        </div>
      </div>
      {info && (
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          {info}
        </div>
      )}
      {accounts.length === 0 ? (
        <Empty title="Brak rachunków">Dodaj rachunki, aby przypisywać wyciągi i pomijać przelewy między nimi.</Empty>
      ) : (
        <ul className="list-rows">
          {orderAccounts(accounts).map((a) => {
            const ids = a.numbers?.length ? a.numbers : a.number ? [a.number] : []
            const sub = a.parent_id !== null
            return (
              <li key={a.id} className={`list-row clickable ${sub ? 'acc-sub' : ''}`} onClick={() => setEditing(a)} style={{ opacity: a.archived ? 0.5 : 1 }}>
                <span className="tx-ico" style={{ ['--c' as string]: a.color }}>
                  {a.is_group ? '🏦' : sub ? '↳' : '▭'}
                </span>
                <div className="list-main">
                  <div className="list-title">
                    {a.name}
                    {a.currency && a.currency !== 'PLN' && <span className="cur-badge">{a.currency}</span>}
                  </div>
                  <div className="list-sub">
                    {a.is_group ? (
                      `bank · ${BANK_LABEL[a.bank] ?? a.bank} · ${accounts.filter((c) => c.parent_id === a.id).length} ${plural(accounts.filter((c) => c.parent_id === a.id).length, 'rachunek', 'rachunki', 'rachunków')}`
                    ) : (
                      <>
                        {sub ? (a.product ? `rachunek w banku · ${a.product}` : 'rachunek w banku') : (BANK_LABEL[a.bank] ?? a.bank)}
                        {ids.length ? ` · ${fmtIdentifier(ids[0])}${ids.length > 1 ? ` +${ids.length - 1}` : ''}` : sub ? '' : ' · bez numeru'}
                        {a.phones?.length ? ` · ☎ ${fmtPhone(a.phones[0])}${a.phones.length > 1 ? ` +${a.phones.length - 1}` : ''}` : ''}
                        {a.savings_goal_name ? ` · ◎ ${a.savings_goal_name}` : ''}
                      </>
                    )}
                  </div>
                </div>
                <div className="num">
                  {a.is_group ? (
                    <div className="tiny muted">{a.balance_known ? `razem ≈ ${money(a.balance)}` : 'saldo ?'}</div>
                  ) : a.balance_known ? (
                    <>
                      <div className={`amount small ${(a.balance ?? 0) < 0 ? 'expense' : ''}`}>{money(a.balance, a.currency)}</div>
                      {a.currency !== 'PLN' && a.balance_pln !== null && <div className="tiny muted">≈ {money(a.balance_pln)}</div>}
                    </>
                  ) : (
                    <div className="tiny muted">saldo ?</div>
                  )}
                  {!a.is_group && (
                    <div className="tiny muted">
                      {a.transaction_count} op. · {fmtDate(a.last_date)}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {editing && <AccountForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
