import { useRef, useState, type DragEvent } from 'react'
import { api } from '../api'
import { AccountSelect } from './AccountSelect'
import { useData, usePeriod, type AddMode } from '../context'
import { BANK_LABEL } from '../format'
import type { ImportPreview, Transaction } from '../types'
import { isImage } from '../ocr/recognize'
import { ShotPicker } from './ShotPicker'
import { TransactionEditor } from './TransactionForm'
import { ErrorBox, Modal } from './ui'

export interface ImportStart {
  preview: ImportPreview
  files: File[]
  bank: string
  accountIds: (number | null)[]
}

const FORMATS = [
  { id: 'auto', label: 'Rozpoznaj automatycznie' },
  { id: 'ipko', label: 'PKO BP (iPKO)' },
  { id: 'ing', label: 'ING Bank Śląski' },
  { id: 'credit_agricole', label: 'Credit Agricole' },
  { id: 'revolut', label: 'Revolut' },
]

function ImportPicker({ onStart, onImages }: { onStart: (s: ImportStart) => void; onImages: (files: File[]) => void }) {
  const { accounts } = useData()
  const { accountId: filterAccount } = usePeriod()
  const [accountId, setAccountId] = useState<number | null>(filterAccount ?? null)
  const [bank, setBank] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  async function handle(files: File[]) {
    if (!files.length) return
    // upuszczone screenshoty obsługuje osobna karta
    if (files.every(isImage)) return onImages(files)
    setBusy(true)
    setError(null)
    try {
      const ids = files.map(() => accountId)
      const preview = await api.importPreview(files, bank, ids)
      onStart({ preview, files, bank, accountIds: ids })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      if (ref.current) ref.current.value = ''
    }
  }

  return (
    <div className="form">
      <div
        className={`dropzone ${drag ? 'drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault()
          setDrag(false)
          handle(Array.from(e.dataTransfer.files))
        }}
        onClick={() => ref.current?.click()}
        role="button"
        tabIndex={0}
      >
        <div className="dropzone-icon">⇪</div>
        <strong>{busy ? 'Analizuję…' : 'Wybierz plik(i) CSV z banku'}</strong>
        <div className="small muted" style={{ marginTop: 4 }}>
          lub przeciągnij tutaj · możesz dodać kilka wyciągów naraz
        </div>
        <div className="bank-logos">
          {['ipko', 'ing', 'credit_agricole', 'revolut'].map((b) => (
            <span key={b} className="badge">
              {BANK_LABEL[b]}
            </span>
          ))}
        </div>
        <input ref={ref} type="file" accept=".csv,.txt,text/csv" multiple hidden onChange={(e) => handle(Array.from(e.target.files ?? []))} />
      </div>
      <div className="grid-2">
        <label>
          Z którego rachunku jest ten wyciąg?
          <AccountSelect value={accountId} onChange={setAccountId} emptyLabel={accounts.length ? 'Rozpoznaj z pliku / bez rachunku' : 'Bez rachunku (możesz dodać nowy)'} />
        </label>
        <label>
          Format pliku
          <select value={bank} onChange={(e) => setBank(e.target.value)}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="small muted">
        Rachunek pozwala liczyć saldo z kolumny „saldo po transakcji” i statystyki per rachunek. Przy kilku plikach z różnych rachunków
        rachunek każdego pliku zmienisz na następnym ekranie.
      </p>
      <p className="small muted">
        Nic nie zostanie zapisane od razu — najpierw zobaczysz listę do sprawdzenia, z wykrytymi duplikatami i podpowiedziami kategorii.
      </p>
      <ErrorBox error={error} />
    </div>
  )
}

export function AddSheet({
  mode: initialMode,
  initial,
  onClose,
  onImport,
}: {
  mode: AddMode
  initial?: Partial<Transaction>
  onClose: () => void
  onImport: (s: ImportStart) => void
}) {
  const [mode, setMode] = useState<AddMode>(initialMode)
  const [images, setImages] = useState<File[]>([])
  return (
    <Modal title="Dodaj" onClose={onClose} guard>
      <div className="segmented" style={{ marginBottom: 18 }}>
        <button className={`seg ${mode === 'manual' ? 'active' : ''}`} onClick={() => setMode('manual')}>
          ✎ Ręcznie
        </button>
        <button className={`seg ${mode === 'import' ? 'active' : ''}`} onClick={() => setMode('import')}>
          ⇪ Z banku
        </button>
        <button className={`seg ${mode === 'shot' ? 'active' : ''}`} onClick={() => setMode('shot')}>
          ▣ Screenshot
        </button>
      </div>
      {mode === 'manual' && <TransactionEditor initial={initial} onDone={onClose} />}
      {mode === 'import' && (
        <ImportPicker
          onStart={onImport}
          onImages={(files) => {
            setImages(files)
            setMode('shot')
          }}
        />
      )}
      {mode === 'shot' && <ShotPicker initial={images} onStart={onImport} />}
    </Modal>
  )
}
