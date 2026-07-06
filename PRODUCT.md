# Product

## Register

product

## Users

Engineers running fleets of AI coding agents against their own repositories — the same person who
runs `pnpm dev` / `auralis start` in a terminal. They open the dashboard (studio) next to that
terminal to watch a run live, inspect what the brain knows, and answer "why did it do that?".
Usually on a large desktop screen beside an editor, occasionally on a phone to check a
long-running fleet.

## Product Purpose

The studio is the observability surface for the auralis brain (oracle-lite): activity timeline,
run history, timing breakdown, knowledge graph, honest ADR log, and semantic search. Success is a
user finding the answer to "what did the fleet do, and what does it know?" in seconds, and
trusting what they see — the dashboard shows evidence (counts, spans, provenance), never vibes.

## Brand Personality

Terminal-native, evidence-first, honest. It reads like a very good CLI: dark, monospace where data
lives, event glyphs (━ ▸ ✓ ⚠ ↻) mirroring the CLI reader, lowercase headings ("auralis · brain").
Numbers and provenance carry the page; decoration earns its place or doesn't exist. Errors are
stated plainly ("can't reach oracle-lite"), never dressed up as empty states.

## Anti-references

- Polished marketing-SaaS dashboards (gradient heroes, celebratory illustrations, onboarding confetti).
- Metric-vanity layouts — big numbers styled for impressiveness rather than comparison.
- Anything that hides uncertainty: fake loading shimmer over stale data, empty states that mask errors.

## Design Principles

1. **Evidence over assertion** — every claim on screen traces to data (counts, spans, ids); show the id, the timestamp, the source.
2. **Mirror the CLI** — the timeline reads the same here and in the terminal reader; one vocabulary of glyphs and kinds.
3. **Live but calm** — polling updates in place; nothing jumps, re-randomizes, or flashes on a tick.
4. **Honest failure** — a dead brain shows an error, a superseded note shows its flag; never silently blank.
5. **Density with hierarchy** — data-dense panels are fine; hierarchy comes from type scale and muted-vs-foreground, not chrome.

## Accessibility & Inclusion

WCAG AA: text contrast ≥4.5:1 (≥3:1 for large text), visible focus states, reduced-motion
respected for any animation. Responsive from 375px (iPhone SE) up; the primary surface is desktop
but every panel must be usable on a phone.
