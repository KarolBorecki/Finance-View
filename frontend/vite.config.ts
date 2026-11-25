import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** Moduł odczytu screenshotów (Tesseract + polski model) pod stałym adresem `ocr/` — z tej samej
 * domeny co aplikacja, więc nic nie jest pobierane z zewnątrz ani nigdzie wysyłane. */
const OCR_FILES = [
  'tesseract.js/dist/worker.min.js',
  'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  '@tesseract.js-data/pol/4.0.0_best_int/pol.traineddata.gz',
].map((f) => join(import.meta.dirname, 'node_modules', f))

function ocrAssets(): Plugin {
  let outDir = 'dist'
  return {
    name: 'finanse-ocr',
    configResolved(c) {
      outDir = c.build.outDir
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = /^\/ocr\/([\w.-]+)(?:\?.*)?$/.exec(req.url ?? '')?.[1]
        const file = OCR_FILES.find((f) => basename(f) === name)
        if (!file) return next()
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(readFileSync(file))
      })
    },
    writeBundle() {
      mkdirSync(join(outDir, 'ocr'), { recursive: true })
      for (const f of OCR_FILES) copyFileSync(f, join(outDir, 'ocr', basename(f)))
    },
  }
}

/** Generuje service worker (dist/sw.js) z listą plików do pracy offline — aplikacja z ekranu
 * początkowego iPhone'a działa wtedy bez internetu. */
function serviceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'finanse-sw',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir
    },
    closeBundle() {
      const files: string[] = []
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name)
          if (statSync(p).isDirectory()) walk(p)
          else files.push(relative(outDir, p).split('\\').join('/'))
        }
      }
      walk(outDir)
      // fonty: z góry tylko polskie/łacińskie podzbiory, resztę (cyrylica, greka…) SW dociągnie w razie potrzeby
      const assets = files.filter((f) => f !== 'sw.js' && !f.endsWith('.map') && (!/\.woff2?$/.test(f) || /-latin-/.test(f)) && !/^(ocr|splash)\//.test(f))
      // odczyt screenshotów (kilka MB): pobierany przy pierwszym użyciu, osobna pamięć przetrwa aktualizacje
      const ocrVersion = createHash('sha256').update(files.filter((f) => f.startsWith('ocr/')).map((f) => `${f}:${statSync(join(outDir, f)).size}`).join('|')).digest('hex').slice(0, 12)
      const version = createHash('sha256').update(assets.join('|')).digest('hex').slice(0, 12)
      const precache = ['./', ...assets.map((f) => `./${f}`)]
      writeFileSync(
        join(outDir, 'sw.js'),
        `// wygenerowane przy budowaniu — nie edytuj
const CACHE = 'finanse-${version}'
const OCR_CACHE = 'finanse-ocr-${ocrVersion}'
const PRECACHE = ${JSON.stringify(precache)}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('finanse-') && k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})
self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return
  if (req.mode === 'navigate') {
    // najpierw sieć (nowa wersja), bez sieci — zapisana kopia
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./', copy))
          return res
        })
        .catch(() => caches.match('./').then((r) => r || caches.match('./index.html'))),
    )
    return
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(url.pathname.includes('/ocr/') ? OCR_CACHE : CACHE).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})
`,
      )
    },
  }
}

// base './' — zbudowana aplikacja działa z dowolnego adresu (serwer FastAPI, GitHub Pages, Netlify…).
// W trybie deweloperskim zapytania /api są przekazywane do backendu FastAPI.
export default defineConfig({
  base: './',
  plugins: [react(), ocrAssets(), serviceWorker()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
