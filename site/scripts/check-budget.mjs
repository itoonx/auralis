// Hard performance budgets (landing plan §5), enforced on dist/ in CI.
// Fails the build on regression — budget drift becomes a build failure,
// not a review comment.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist')

const gz = (p) => gzipSync(readFileSync(p)).length
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const files = walk(dist)
const kb = (n) => `${(n / 1024).toFixed(1)}KB`

const html = gz(join(dist, 'index.html')) // inline scripts/styles included
const css = files.filter((f) => extname(f) === '.css').reduce((s, f) => s + gz(f), 0)
const js = files.filter((f) => extname(f) === '.js').reduce((s, f) => s + gz(f), 0)
const fonts = files.filter((f) => /\.(woff2?|ttf)$/.test(f)).reduce((s, f) => s + gz(f), 0)
const raster = files.filter((f) => /\.(png|jpe?g|webp|avif)$/.test(f) && !f.endsWith('og.png'))
const firstLoad = html + css + js + fonts // og.png is not part of first load

const checks = [
  ['index.html (incl. inline JS) gz', html, 40 * 1024],
  ['external JS gz', js, 90 * 1024],
  ['CSS gz', css, 30 * 1024],
  // 65KB covered Geist+Geist Mono latin; the hero display serif (Cormorant
  // Garamond variable, normal+italic) adds ~77KB by explicit request
  ['fonts', fonts, 150 * 1024],
  ['first-load total gz', firstLoad, 300 * 1024],
]

let failed = false
for (const [name, actual, budget] of checks) {
  const ok = actual <= budget
  if (!ok) failed = true
  console.log(`${ok ? '✓' : '✗'} ${name}: ${kb(actual)} (budget ${kb(budget)})`)
}
for (const f of raster) {
  const size = statSync(f).size
  if (size > 60 * 1024) {
    failed = true
    console.log(`✗ raster over 60KB: ${f} (${kb(size)})`)
  }
}
process.exit(failed ? 1 : 0)
