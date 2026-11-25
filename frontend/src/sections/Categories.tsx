import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { EmojiPicker } from '../components/EmojiPicker'
import { Empty, ErrorBox, Modal } from '../components/ui'
import { useData } from '../context'
import { fuzzyScore } from '../fuzzy'
import { money, PALETTE } from '../format'
import type { Category, CategoryKind } from '../types'


export function CategoryForm({ initial, onClose }: { initial: Partial<Category>; onClose: () => void }) {
  const { bump } = useData()
  const [name, setName] = useState(initial.name ?? '')
  const [kind, setKind] = useState<CategoryKind>(initial.kind ?? 'expense')
  const [color, setColor] = useState(initial.color ?? PALETTE[0])
  const [icon, setIcon] = useState(initial.icon ?? '')
  const [budget, setBudget] = useState(initial.monthly_budget ? String(initial.monthly_budget).replace('.', ',') : '')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const b = budget.trim() ? Number(budget.replace(/\s/g, '').replace(',', '.')) : null
    if (b !== null && (!Number.isFinite(b) || b < 0)) return setError('Nieprawidłowy budżet')
    const data = { name, kind, color, icon: icon.trim() || null, monthly_budget: b }
    try {
      if (initial.id) await api.updateCategory(initial.id, data)
      else await api.createCategory(data)
      bump()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Modal title={initial.id ? 'Edytuj kategorię' : 'Nowa kategoria'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="segmented">
          {(['expense', 'income'] as const).map((k) => (
            <button type="button" key={k} className={`seg seg-${k} ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
              {k === 'expense' ? 'Wydatki' : 'Wpływy'}
            </button>
          ))}
        </div>
        <label>
          Nazwa
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="np. Kot" />
        </label>
        <div>
          <div className="small muted" style={{ marginBottom: 8 }}>
            Ikona
          </div>
          <EmojiPicker value={icon} onChange={setIcon} />
        </div>
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
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Własny kolor" />
          </div>
        </div>
        {kind === 'expense' && (
          <label>
            Miesięczny budżet <span className="muted">(opcjonalnie, PLN)</span>
            <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="np. 1200" />
          </label>
        )}
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

type Show = 'all' | 'used' | 'unused' | 'budget'
type Sort = 'name' | 'count' | 'budget'

export function CategoriesSection() {
  const { categories, bump } = useData()
  const [kind, setKind] = useState<CategoryKind>('expense')
  const [editing, setEditing] = useState<Partial<Category> | null>(null)
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [sort, setSort] = useState<Sort>('name')
  const ofKind = categories.filter((c) => c.kind === kind)
  const scored = ofKind
    .map((c) => ({ c, score: q.trim() ? fuzzyScore(q, c.name) : 1 }))
    .filter((x) => x.score !== null)
    .filter(({ c }) => show === 'all' || (show === 'used' ? c.transaction_count > 0 : show === 'unused' ? c.transaction_count === 0 : !!c.monthly_budget))
  const list = scored
    .sort(
      (a, b) =>
        (q.trim() ? b.score! - a.score! : 0) ||
        (sort === 'count' ? b.c.transaction_count - a.c.transaction_count : sort === 'budget' ? (b.c.monthly_budget ?? -1) - (a.c.monthly_budget ?? -1) : 0) ||
        a.c.name.localeCompare(b.c.name, 'pl'),
    )
    .map((x) => x.c)
  const counts = {
    all: ofKind.length,
    used: ofKind.filter((c) => c.transaction_count > 0).length,
    unused: ofKind.filter((c) => c.transaction_count === 0).length,
    budget: ofKind.filter((c) => !!c.monthly_budget).length,
  }
  return (
    <div className="card">
      <div className="card-head">
        <h3>Kategorie</h3>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing({ kind })}>
          + Kategoria
        </button>
      </div>
      <div className="segmented" style={{ marginBottom: 8, maxWidth: 320 }}>
        <button className={`seg seg-expense ${kind === 'expense' ? 'active' : ''}`} onClick={() => setKind('expense')}>
          Wydatki
        </button>
        <button className={`seg seg-income ${kind === 'income' ? 'active' : ''}`} onClick={() => (setKind('income'), show === 'budget' && setShow('all'), sort === 'budget' && setSort('name'))}>
          Wpływy
        </button>
      </div>
      <div className="cat-filters">
        <input placeholder="Szukaj kategorii…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Szukaj kategorii" />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sortuj kategorie">
          <option value="name">Sortuj: nazwa</option>
          <option value="count">Sortuj: liczba transakcji</option>
          {kind === 'expense' && <option value="budget">Sortuj: budżet</option>}
        </select>
      </div>
      <div className="chips" style={{ marginBottom: 8 }}>
        {(
          [
            ['all', 'Wszystkie'],
            ['used', 'Używane'],
            ['unused', 'Nieużywane'],
            ...(kind === 'expense' ? [['budget', 'Z budżetem']] : []),
          ] as [Show, string][]
        ).map(([id, label]) => (
          <button key={id} className={`chip-btn ${show === id ? 'active' : ''}`} onClick={() => setShow(id)}>
            {label} <span className="count">{counts[id]}</span>
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <Empty title={ofKind.length ? 'Żadna kategoria nie pasuje do filtrów' : 'Brak kategorii'} />
      ) : (
        <ul className="list-rows">
          {list.map((c) => (
            <li key={c.id} className="list-row clickable" onClick={() => setEditing(c)}>
              <span className="tx-ico" style={{ ['--c' as string]: c.color }}>
                {c.icon || '●'}
              </span>
              <div className="list-main">
                <div className="list-title">{c.name}</div>
                <div className="list-sub">
                  {c.transaction_count} transakcji{c.monthly_budget ? ` · budżet ${money(c.monthly_budget)}/mies.` : ''}
                </div>
              </div>
              <button
                className="icon-btn"
                aria-label="Usuń"
                onClick={async (e) => {
                  e.stopPropagation()
                  const msg = c.transaction_count
                    ? `Kategoria „${c.name}” ma ${c.transaction_count} transakcji — staną się „bez kategorii”. Usunąć?`
                    : `Usunąć kategorię „${c.name}”?`
                  if (!confirm(msg)) return
                  await api.deleteCategory(c.id)
                  bump()
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <CategoryForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
