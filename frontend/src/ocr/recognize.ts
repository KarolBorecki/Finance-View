/**
 * Rozpoznawanie tekstu na urządzeniu (Tesseract w WebAssembly, polski model językowy).
 * Silnik i model są częścią aplikacji (folder `ocr/`, patrz vite.config.ts) — obraz nigdzie nie jest
 * wysyłany. Ładują się dopiero przy pierwszym screenshocie.
 */
import type { Worker } from 'tesseract.js'
import { isoDate, parseShot, shotDate, type OcrWord, type ShotTx } from './parse'

export interface ShotResult {
  txs: ShotTx[]
  /** dzień przyjęty za „dziś” na screenshocie */
  ref: string
}

const base = () => new URL('ocr/', document.baseURI).href

let workerPromise: Promise<Worker> | null = null
let onProgress: ((p: number) => void) | null = null

function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { createWorker, PSM } = await import('tesseract.js')
    const dir = base()
    const w = await createWorker('pol', 1, {
      workerPath: `${dir}worker.min.js`,
      corePath: dir.replace(/\/$/, ''),
      langPath: dir.replace(/\/$/, ''),
      // zwykły worker z tego samego adresu: działa też w aplikacji z Xcode (capacitor://) i offline
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress?.(m.progress)
      },
    })
    // rozproszony tekst: kwoty po prawej i tytuły po lewej to osobne fragmenty
    await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, user_defined_dpi: '300' })
    return w
  })().catch((e: unknown) => {
    workerPromise = null
    console.error(e)
    throw new Error('Nie udało się uruchomić odczytu tekstu. Przy pierwszym użyciu potrzebny jest internet (pobranie modułu odczytu), potem działa offline.')
  })
  return workerPromise
}

/** Zwalnia pamięć silnika (kilkadziesiąt MB) po zakończeniu pracy. */
export async function releaseOcr(): Promise<void> {
  const p = workerPromise
  workerPromise = null
  try {
    await (await p)?.terminate()
  } catch {
    /* silnik nie wystartował */
  }
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } catch {
    throw new Error('Nie udało się otworzyć obrazu — użyj pliku PNG, JPG lub WebP.')
  } finally {
    // po decode() obraz jest już w pamięci
    URL.revokeObjectURL(url)
  }
}

const MIN_W = 1000
const MAX_W = 1500
const MAX_PIXELS = 9_000_000

/** Odcienie szarości, ciemny motyw odwrócony na jasny, rozmiar dobry dla OCR. */
function prepare(img: HTMLImageElement): HTMLCanvasElement {
  const w0 = img.naturalWidth
  const h0 = img.naturalHeight
  // zwykłe screenshoty telefonu zostają 1:1; małe powiększamy, ogromne zdjęcia zmniejszamy
  let scale = w0 < MIN_W ? Math.min(3, MIN_W / w0) : w0 > MAX_W && w0 < h0 ? MAX_W / w0 : 1
  if (w0 * h0 * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w0 * h0))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w0 * scale))
  c.height = Math.max(1, Math.round(h0 * scale))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Przeglądarka nie pozwala przetworzyć obrazu.')
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(img, 0, 0, c.width, c.height)
  const data = ctx.getImageData(0, 0, c.width, c.height)
  const px = data.data
  let sum = 0
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
    px[i] = px[i + 1] = px[i + 2] = g
    sum += g
  }
  if (sum / (px.length / 4) < 128) for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255 - px[i]
  ctx.putImageData(data, 0, 0)
  return c
}

/** Odczytuje transakcje z jednego screenshota. */
export async function readShot(file: File, progress?: (p: number) => void): Promise<ShotResult> {
  const canvas = prepare(await loadImage(file))
  const worker = await getWorker()
  onProgress = progress ?? null
  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false })
    const words: OcrWord[] = []
    for (const b of data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines) for (const w of l.words) words.push({ text: w.text, conf: w.confidence, ...w.bbox })
    const ref = shotDate(file.name, file.lastModified, isoDate(new Date()))
    return { txs: parseShot(words, { width: canvas.width, height: canvas.height, ref }), ref }
  } finally {
    onProgress = null
    // iOS zwalnia pamięć płótna dopiero po wyzerowaniu rozmiaru
    canvas.width = canvas.height = 0
  }
}

// ---------- zapis do zwykłego importu ----------
const csvCell = (s: string) => `"${s.replace(/\s+/g, ' ').replace(/"/g, '""')}"`

/** Odczytane pozycje jako plik CSV — dalej idzie tą samą drogą co wyciąg z banku (format „screenshot”). */
export function shotCsv(txs: Pick<ShotTx, 'date' | 'amount' | 'currency' | 'title' | 'details'>[], filename: string): File {
  const rows = txs.map((t) => [t.date, t.amount.toFixed(2), t.currency, t.title, t.details].map(csvCell).join(';'))
  return new File([['Data ze screenshota;Kwota;Waluta;Tytuł;Szczegóły', ...rows].join('\n')], filename, { type: 'text/csv' })
}

export const isImage = (f: File) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif|gif|bmp)$/i.test(f.name)
