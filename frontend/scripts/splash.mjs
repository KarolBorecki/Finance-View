/**
 * Generuje obrazy ekranu startowego z grafiki w index.html (#splash), żeby splash iOS i pierwszy ekran
 * aplikacji były identyczne:  npm run splash   (wymaga Chrome/Chromium; inna ścieżka: CHROME=/…)
 *   - public/splash/*.png                — aplikacja z ekranu początkowego (PWA), rozmiary z index.html
 *   - ios/…/Splash.imageset/*.png        — aplikacja z Xcode (2732×2732, LaunchScreen.storyboard)
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const html = readFileSync(join(root, 'index.html'), 'utf8')
const style = /<style id="splash-style">([\s\S]*?)<\/style>/.exec(html)[1]
const splash = /<div id="splash">[\s\S]*?<\/div>/.exec(html)[0]
const sizes = [...new Set([...html.matchAll(/splash\/(\d+x\d+)\.png/g)].map((m) => m[1]))]

const candidates = [process.env.CHROME, 'google-chrome', 'chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean)
const chrome = candidates.find((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})
if (!chrome) throw new Error('Nie znaleziono Chrome — ustaw zmienną CHROME.')

const tmp = mkdtempSync(join(tmpdir(), 'splash-'))
const page = join(tmp, 'splash.html')
writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>body{margin:0}${style}</style>${splash}`)
const shot = (size, out) =>
  execFileSync(
    chrome,
    ['--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${join(tmp, 'profile')}`, `--window-size=${size.replace('x', ',')}`, `--screenshot=${out}`, pathToFileURL(page).href],
    { stdio: 'ignore' },
  )

mkdirSync(join(root, 'public/splash'), { recursive: true })
for (const s of sizes) shot(s, join(root, 'public/splash', `${s}.png`))
const ios = join(root, 'ios/App/App/Assets.xcassets/Splash.imageset')
shot('2732x2732', join(ios, 'splash-2732x2732.png'))
for (const n of ['-1', '-2']) copyFileSync(join(ios, 'splash-2732x2732.png'), join(ios, `splash-2732x2732${n}.png`))
rmSync(tmp, { recursive: true, force: true })
console.log(`Gotowe: ${sizes.length} obrazów PWA + Splash.imageset`)
