// Guard against design-token drift between the dashboard (source of truth)
// and the landing site. The repo has no pnpm workspace, so tokens.css is a
// verbatim copy of the `:root` and `.dark` blocks in dashboard/src/index.css.
//
//   node scripts/check-token-drift.mjs          # CI: exit 1 on drift
//   node scripts/check-token-drift.mjs --write  # regenerate tokens.css
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(here, '../../dashboard/src/index.css')
const TARGET = resolve(here, '../src/styles/tokens.css')

const HEADER = `/* GENERATED COPY — do not edit by hand.
 * Source of truth: dashboard/src/index.css (:root and .dark blocks).
 * Regenerate: node scripts/check-token-drift.mjs --write
 * CI diff-checks this file against the source. */
`

function extractBlock(css, selector) {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`selector not found in source: ${selector}`)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces for: ${selector}`)
}

const source = readFileSync(SOURCE, 'utf8')
const expected = `${HEADER}\n${extractBlock(source, ':root')}\n\n${extractBlock(source, '.dark')}\n`

if (process.argv.includes('--write')) {
  writeFileSync(TARGET, expected)
  console.log(`wrote ${TARGET}`)
} else {
  const actual = readFileSync(TARGET, 'utf8')
  if (actual !== expected) {
    console.error('token drift: site/src/styles/tokens.css no longer matches dashboard/src/index.css')
    console.error('fix: node scripts/check-token-drift.mjs --write')
    process.exit(1)
  }
  console.log('tokens in sync')
}
