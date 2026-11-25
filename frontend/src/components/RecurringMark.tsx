import type { Rule, RuleField, Transaction } from '../types'

const NOISE = new Set(['zakup', 'platnosc', 'płatność', 'karta', 'kartą', 'blik', 'przelew', 'transakcja', 'pos'])
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')

/** Nazwa odbiorcy bez numerów i prefiksów płatności („BLIK NETFLIX.COM 866” → „NETFLIX.COM”). */
function payeeName(src: string): string {
  const words: string[] = []
  for (const tok of src.split('|')[0].trim().split(/\s+/)) {
    if (!tok) continue
    if (/\d/.test(tok) || tok.startsWith('*')) break
    if (!words.length && NOISE.has(fold(tok))) continue
    words.push(tok)
  }
  return words.join(' ').replace(/^[\s|,;:/—-]+|[\s|,;:/—-]+$/g, '')
}

/** Szkic zwykłej reguły z opcją „wydatek stały” dla wydatku: numer rachunku odbiorcy, a bez niego
 * kontrahent (albo początek opisu) z `*`; kategoria jak w wydatku. */
export function recurringRuleDraft(tx: Partial<Transaction>, recurringId?: number): Partial<Rule> {
  const digits = (tx.counterparty_account ?? '').replace(/\D/g, '')
  let field: RuleField = 'description'
  let pattern = ''
  if (digits.length >= 10) {
    field = 'counterparty_account'
    pattern = digits
  } else if (tx.counterparty?.trim()) {
    field = 'counterparty'
    const name = payeeName(tx.counterparty)
    pattern = name ? `${name}*` : tx.counterparty.trim()
  } else {
    const name = payeeName(tx.description ?? '')
    pattern = name ? `${name}*` : (tx.description ?? '').trim().slice(0, 60)
  }
  return {
    pattern,
    field,
    direction: 'expense',
    category_id: tx.category_id ?? null,
    savings_goal_id: null,
    mark_transfer: false,
    transfer_account_id: null,
    priority: 0,
    mark_recurring: true,
    recurring_id: recurringId ?? null,
  }
}
