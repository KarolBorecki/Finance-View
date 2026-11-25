import type { ReactNode } from 'react'
import type { Account } from '../types'

/** Opcje listy kont: konta główne (foldery) jako grupy z subkontami w środku.
 * Folder da się wybrać tylko z `allowGroups` (np. import wyciągu — operacje trafią do subkont). */
export function AccountOptions({
  accounts,
  allowGroups = false,
  valueFor: valueOfProp,
  labelOf,
  disabledOf,
}: {
  accounts: Account[]
  allowGroups?: boolean
  valueFor?: (a: Account) => string
  labelOf?: (a: Account) => ReactNode
  disabledOf?: (a: Account) => boolean
}) {
  const ids = new Set(accounts.map((a) => a.id))
  const valueOf = valueOfProp ?? ((a: Account) => String(a.id))
  const label = labelOf ?? ((a: Account) => a.name)
  const opt = (a: Account, sub = false) => (
    <option key={a.id} value={valueOf(a)} disabled={disabledOf?.(a)}>
      {sub ? '↳ ' : ''}
      {label(a)}
    </option>
  )
  return (
    <>
      {accounts
        .filter((a) => a.parent_id === null || !ids.has(a.parent_id))
        .map((a) => {
          const kids = accounts.filter((c) => c.parent_id === a.id)
          if (!a.is_group) return opt(a)
          return (
            <optgroup key={a.id} label={`🏦 ${a.name}`}>
              {allowGroups && (
                <option value={valueOf(a)} disabled={disabledOf?.(a)}>
                  {a.name} — wszystkie rachunki
                </option>
              )}
              {kids.map((k) => opt(k, true))}
            </optgroup>
          )
        })}
    </>
  )
}

/** Opcje „przelew własny” w listach kategorii: osobna grupa dla każdego banku, żeby było
 * widać, który rachunek należy do którego banku. Wartości `t:<id>`. */
export function TransferOptions({
  accounts,
  exclude,
  label,
  prefix = '⇄',
}: {
  accounts: Account[]
  exclude?: number | null
  label?: (a: Account) => string
  prefix?: string
}) {
  const banks = accounts.filter((a) => a.is_group)
  const usable = accounts.filter((a) => !a.is_group && a.id !== exclude)
  const name = label ?? ((a: Account) => a.name)
  const orphans = usable.filter((a) => !banks.some((b) => b.id === a.parent_id))
  return (
    <>
      <optgroup label="⇄ Przelew własny (pomiń w statystykach)">
        <option value="t:">⇄ Przelew własny — rachunek nieznany</option>
        {orphans.map((a) => (
          <option key={a.id} value={`t:${a.id}`}>
            {prefix} {name(a)}
          </option>
        ))}
      </optgroup>
      {banks.map((b) => {
        const kids = usable.filter((a) => a.parent_id === b.id)
        if (!kids.length) return null
        return (
          <optgroup key={b.id} label={`⇄ Przelew własny → 🏦 ${b.name}`}>
            {kids.map((a) => (
              <option key={a.id} value={`t:${a.id}`}>
                {prefix} {name(a)}
                {a.currency && a.currency !== 'PLN' ? ` (${a.currency})` : ''}
              </option>
            ))}
          </optgroup>
        )
      })}
    </>
  )
}
