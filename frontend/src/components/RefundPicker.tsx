import { useState } from 'react'
import { fmtDate, money } from '../format'
import type { RefundCandidate } from '../types'
import { useRefundCandidates, type RefundQuery } from './refunds'

const who = (c: RefundCandidate) => c.transaction.counterparty || c.transaction.description || '(brak opisu)'
const origAmount = (c: RefundCandidate) =>
  c.transaction.currency !== 'PLN' && c.transaction.amount_orig != null ? money(c.transaction.amount_orig, c.transaction.currency) : money(c.transaction.amount)


/** Panel wyboru wydatku, za który przyszedł zwrot — osadzony w formularzu transakcji. */
export function RefundPicker({ query, onPick, onClose }: { query: RefundQuery; onPick: (c: RefundCandidate) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const { items, error } = useRefundCandidates(query, q.trim())
  return (
    <div className="refund-picker" role="group" aria-label="Wybierz wydatek, którego dotyczy zwrot">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="strong small">Za który wydatek jest ten zwrot?</div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Zamknij wybór wydatku">
          ✕
        </button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj po opisie lub kontrahencie (dowolna kwota)" aria-label="Szukaj wydatku" />
      <p className="tiny muted" style={{ margin: 0 }}>
        {q.trim()
          ? 'Wyniki wyszukiwania z ostatniego roku — bez względu na kwotę.'
          : 'Wcześniejsze wydatki z ostatniego roku z tą samą albo podobną kwotą (±25%).'}
      </p>
      {error && <div className="small t-expense">{error}</div>}
      {items === null ? (
        <div className="small muted">Szukam…</div>
      ) : items.length === 0 ? (
        <div className="small muted">{q.trim() ? 'Nic nie znaleziono.' : 'Brak pasujących wydatków — spróbuj wyszukać po nazwie.'}</div>
      ) : (
        <ul className="refund-list">
          {items.map((c) => (
            <li key={c.transaction.id}>
              <button type="button" className="refund-item" onClick={() => onPick(c)}>
                <span className="dupe-line">
                  <span className="tiny muted nowrap">{fmtDate(c.transaction.date)}</span>
                  <span className="truncate">{who(c)}</span>
                  <span className="amount small t-expense">{origAmount(c)}</span>
                </span>
                <span className="tiny muted">
                  {c.reason}
                  {c.transaction.category_name ? ` · ${c.transaction.category_name}` : ''}
                  {c.transaction.refunded ? ` · zwrócono już ${money(c.transaction.refunded)}, zostało ${money(c.remaining)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
