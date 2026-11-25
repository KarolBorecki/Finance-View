import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { api } from '../api'
import { useData, useToast } from '../context'
import { fmtDate, money, plural } from '../format'
import type { RuleField, RuleProposal } from '../types'
import { Modal } from './ui'

const FIELD: Record<RuleField, string> = {
  counterparty: 'kontrahent',
  description: 'opis',
  title: 'tytuł',
  counterparty_account: 'nr rachunku',
}

const Ctx = createContext<((list: RuleProposal[]) => void) | null>(null)

export function useProposals() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useProposals poza ProposalProvider')
  return { show: ctx }
}

function RuleBadge({ p, target }: { p: RuleProposal; target?: string }) {
  return (
    <div className="rule-card">
      <div className="tiny muted">
        Reguła · {FIELD[p.field]} · {p.direction === 'expense' ? 'wydatki' : p.direction === 'income' ? 'wpływy' : 'wszystkie'}
      </div>
      <div className="rule-line">
        <code>{p.pattern}</code>
        <span className="muted">→</span>
        <strong>{target ?? p.target_label}</strong>
      </div>
      {p.exclude_pattern && <div className="tiny muted">oprócz: {p.exclude_pattern}</div>}
    </div>
  )
}

function ProposalDialog({ p, onDone }: { p: RuleProposal; onDone: () => void }) {
  const { bump } = useData()
  const toast = useToast()
  const [checked, setChecked] = useState<Set<number>>(() => new Set(p.matches.map((m) => m.id)))
  const [busy, setBusy] = useState(false)
  const all = checked.size === p.matches.length

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      await fn()
      toast(message)
      bump()
      onDone()
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }

  if (p.kind === 'conflict') {
    return (
      <Modal title="Ta transakcja pasuje do reguły" onClose={onDone}>
        <div className="form">
          <RuleBadge p={p} />
          <p className="small">
            Reguła przypisuje <strong>{p.target_label}</strong>, a Ty wybrałeś <strong>{p.new_target_label}</strong>. Co zrobić z kolejnymi takimi
            transakcjami?
          </p>
          <div className="choice-list">
            <button
              className="choice"
              disabled={busy}
              onClick={() => run(() => api.exceptRule(p.rule_id, p.transaction_id!), 'Dodano wyjątek — reguła nie zmieni tej transakcji')}
            >
              <strong>Wyjątek — tylko ta transakcja</strong>
              <span className="small muted">Reguła zostaje bez zmian, ta transakcja zachowa „{p.new_target_label}”.</span>
            </button>
            <button
              className="choice"
              disabled={busy}
              onClick={() => run(() => api.retargetRule(p.rule_id, p.transaction_id!), `Reguła przypisuje teraz „${p.new_target_label}”`)}
            >
              <strong>Zmień regułę na {p.new_target_label}</strong>
              <span className="small muted">Kolejne transakcje z tego źródła dostaną nową kategorię.</span>
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  const toggle = (id: number) =>
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const excluded = p.matches.filter((m) => !checked.has(m.id)).map((m) => m.id)

  return (
    <Modal title="Uzupełnić podobne transakcje?" onClose={onDone}>
      <div className="form">
        <RuleBadge p={p} />
        <p className="small">
          Zapamiętałem tę regułę. Pasuje do niej jeszcze <strong>{p.match_count}</strong>{' '}
          {plural(p.match_count, 'transakcja', 'transakcje', 'transakcji')} bez kategorii. Odznacz te, które mają zostać <strong>wyjątkami</strong> —
          reguła nigdy ich nie zmieni.
        </p>
        <div className="match-list">
          <label className="match-row match-all">
            <input type="checkbox" checked={all} onChange={() => setChecked(all ? new Set() : new Set(p.matches.map((m) => m.id)))} />
            <span className="small strong">Zaznacz wszystkie</span>
            <span className="spacer" />
            <span className="tiny muted">
              {checked.size} / {p.matches.length}
            </span>
          </label>
          {p.matches.map((m) => (
            <label key={m.id} className={`match-row ${checked.has(m.id) ? '' : 'off'}`}>
              <input type="checkbox" checked={checked.has(m.id)} onChange={() => toggle(m.id)} />
              <span className="list-main">
                <span className="list-title small">{m.description}</span>
                <span className="list-sub">
                  {fmtDate(m.date)}
                  {m.account_name ? ` · ${m.account_name}` : ''}
                  {!checked.has(m.id) && ' · wyjątek'}
                </span>
              </span>
              <span className={`amount small ${m.type === 'income' ? 'pos' : 'neg'}`}>{money(m.amount)}</span>
            </label>
          ))}
          {p.match_count > p.matches.length && <div className="tiny muted" style={{ padding: 8 }}>…i {p.match_count - p.matches.length} więcej (zostaną uzupełnione)</div>}
        </div>
        <div className="sheet-actions stack-actions">
          <button
            className="btn btn-primary btn-lg"
            disabled={busy || checked.size === 0}
            onClick={() =>
              run(
                () => api.applyRule(p.rule_id, p.match_count > p.matches.length && all ? null : [...checked], excluded),
                `Uzupełniono ${checked.size} ${plural(checked.size, 'transakcję', 'transakcje', 'transakcji')}${excluded.length ? ` · wyjątki: ${excluded.length}` : ''}`,
              )
            }
          >
            Uzupełnij zaznaczone ({checked.size})
          </button>
          <div className="row">
            <button className="btn btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={onDone}>
              Tylko zapamiętaj
            </button>
            <button className="btn btn-danger" style={{ flex: 1 }} disabled={busy} onClick={() => run(() => api.deleteRule(p.rule_id), 'Reguła nie została zapisana')}>
              Nie twórz reguły
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function ProposalProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<RuleProposal[]>([])
  const toast = useToast()
  const { bump } = useData()
  const show = useCallback(
    (list: RuleProposal[]) => {
      const ask: RuleProposal[] = []
      for (const p of list) {
        if (p.kind === 'new_rule' && p.match_count === 0) {
          toast(`Zapamiętano: ${p.pattern} → ${p.target_label}`, {
            label: 'Cofnij',
            run: () => {
              api.deleteRule(p.rule_id).then(bump)
            },
          })
        } else ask.push(p)
      }
      if (ask.length) setQueue((q) => [...q, ...ask])
    },
    [toast, bump],
  )
  const current = queue[0]
  return (
    <Ctx.Provider value={show}>
      {children}
      {current && <ProposalDialog key={`${current.rule_id}-${current.kind}-${queue.length}`} p={current} onDone={() => setQueue((q) => q.slice(1))} />}
    </Ctx.Provider>
  )
}
