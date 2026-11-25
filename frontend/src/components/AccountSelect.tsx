import { useState } from 'react'
import { useData } from '../context'
import { BANK_LABEL } from '../format'
import { AccountOptions } from './AccountOptions'
import { AccountForm } from '../sections/Accounts'

const NEW = '__new__'

/** Wybór konta z opcją utworzenia nowego na miejscu (np. przy imporcie wyciągu). */
export function AccountSelect({
  value,
  onChange,
  emptyLabel = '— bez rachunku —',
  suggest,
  disabled,
  className,
  ariaLabel = 'Rachunek',
  allowGroups = false,
}: {
  value: number | null
  onChange: (id: number | null) => void
  emptyLabel?: string
  suggest?: { bank?: string | null; number?: string | null; name?: string | null }
  disabled?: boolean
  className?: string
  ariaLabel?: string
  /** czy można wybrać konto główne (folder) — tylko przy imporcie wyciągu */
  allowGroups?: boolean
}) {
  const { accounts } = useData()
  const [creating, setCreating] = useState(false)
  const list = accounts.filter((a) => !a.archived || a.id === value)
  const bank = suggest?.bank && BANK_LABEL[suggest.bank] ? suggest.bank : 'other'
  return (
    <>
      <select
        className={className}
        value={value ?? ''}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => {
          if (e.target.value === NEW) return setCreating(true)
          onChange(e.target.value ? Number(e.target.value) : null)
        }}
      >
        <option value="">{emptyLabel}</option>
        <AccountOptions
          accounts={list}
          allowGroups={allowGroups}
          labelOf={(a) =>
            `${a.name}${a.parent_id ? '' : a.bank && a.bank !== 'other' && !a.is_group ? ` · ${BANK_LABEL[a.bank] ?? a.bank}` : ''}${
              a.currency && a.currency !== 'PLN' && !a.is_group && !a.name.includes(a.currency) ? ` (${a.currency})` : ''
            }`
          }
        />
        <option value={NEW}>＋ Nowy rachunek…</option>
      </select>
      {creating && (
        <AccountForm
          initial={{
            name: suggest?.name ?? (bank !== 'other' ? BANK_LABEL[bank].replace(/ \(.*\)$/, '') : ''),
            bank,
            number: suggest?.number ?? null,
            numbers: suggest?.number ? [suggest.number] : [],
          }}
          onClose={() => setCreating(false)}
          onSaved={(a) => onChange(a.id)}
        />
      )}
    </>
  )
}

