// One clock everywhere: the viewer's local time, 24h, via dayjs. The brain stores UTC ISO strings and the
// CLI prints them with an explicit "(UTC)" label; the studio localizes instead — and every timestamp on
// screen goes through these helpers, so the header clock, the feed and the runs table can never disagree
// by a timezone again (they used to mix raw UTC slices with 12h locale strings, 7 hours apart at UTC+7).
import dayjs from "dayjs"
import relativeTime from "dayjs/plugin/relativeTime"

dayjs.extend(relativeTime)

/** HH:mm:ss, local 24h. */
export function clock(iso?: string | number | Date): string {
  if (iso == null || iso === "") return "--:--:--"
  const d = dayjs(iso)
  return d.isValid() ? d.format("HH:mm:ss") : "--:--:--"
}

/** YYYY-MM-DD HH:mm, local 24h — for run rows where the day matters. */
export function dateTime(iso?: string): string {
  if (!iso) return "—"
  const d = dayjs(iso)
  return d.isValid() ? d.format("YYYY-MM-DD HH:mm") : "—"
}

/** Relative age — reads well next to absolute times when the exact moment doesn't matter (findings). */
export function ago(iso?: string): string {
  if (!iso) return ""
  const d = dayjs(iso)
  return d.isValid() ? d.fromNow() : ""
}

/** Span durations from the timing sink: "340ms" under a second, "1.2s" above. */
export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(ms < 10 ? 1 : 0)}ms`
}

/** Wall-clock spans between two timestamps: "42s", "8m 59s", "2h 05m". */
export function fmtDur(fromIso?: string, toIso?: string): string {
  if (!fromIso || !toIso) return "—"
  const a = dayjs(fromIso), b = dayjs(toIso)
  if (!a.isValid() || !b.isValid()) return "—"
  const s = Math.max(0, b.diff(a, "second"))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}
