// Typed access to the frozen run export — the page's single source of truth
// for on-page run data (no literals in components).
import run from '../data/run.json'

export type RunEvent = (typeof run.events)[number]
export const runData = run

export function fmtOffset(t: number): string {
  const s = Math.floor(t / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function shortRunId(id: string): string {
  return id.length > 34 ? `${id.slice(0, 31)}…` : id
}

export const recordedDate = runData.recordedAt.slice(0, 10)

/** Events that read well in a compact transcript (skip raw prompt dumps). */
export function transcriptEvents(max: number): RunEvent[] {
  const keep = runData.events.filter((e) => e.kind !== 'prompt' && e.text)
  if (keep.length <= max) return keep
  // keep the opening plan, the overlap/finding beats, and the tail
  const head = keep.slice(0, 3)
  const beats = keep.filter((e) => ['overlap', 'finding', 'answer', 'phase'].includes(e.kind)).slice(0, max - 6)
  const tail = keep.slice(-3)
  const seen = new Set<number>()
  return [...head, ...beats, ...tail]
    .filter((e) => (seen.has(e.seq) ? false : (seen.add(e.seq), true)))
    .sort((a, b) => a.seq - b.seq)
    .slice(0, max)
}
