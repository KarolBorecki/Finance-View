import { useEffect, useState } from 'react'
import { api } from '../api'
import type { RefundCandidate } from '../types'

export interface RefundQuery {
  date: string
  amount: number
  currency: string
  description: string
  counterparty: string | null
  account_id: number | null
  exclude_id: number | null
}

/** Etykieta powiązanego wydatku — taka sama jak `refund_of_label` z serwera. */
export function candidateLabel(c: RefundCandidate): string {
  const t = c.transaction
  const w = (t.counterparty || t.description || 'wydatek').split(' | ')[0].trim().slice(0, 60) || 'wydatek'
  const cents = Math.round(Math.abs(t.amount_orig ?? t.amount) * 100)
  const int = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${w} · ${t.date.split('-').reverse().join('.')} · ${int},${String(cents % 100).padStart(2, '0')} ${t.currency || 'PLN'}`
}

/** Kandydaci na wydatek, którego dotyczy zwrot (wcześniejsze wydatki z tą samą lub podobną kwotą). */
export function useRefundCandidates(query: RefundQuery | null, q = '') {
  const [state, setState] = useState<{ key: string; items: RefundCandidate[] | null; error: string | null }>({ key: '', items: null, error: null })
  const key = query ? JSON.stringify({ ...query, q }) : ''
  useEffect(() => {
    if (!key) return
    let alive = true
    const timer = setTimeout(() => {
      api
        .refundCandidates(JSON.parse(key) as RefundQuery & { q: string })
        .then((items) => alive && setState({ key, items, error: null }))
        .catch((e: Error) => alive && setState({ key, items: [], error: e.message }))
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [key])
  // wynik dla starszego zapytania nie jest już aktualny
  return state.key === key && key ? { items: state.items, error: state.error } : { items: null, error: null }
}
