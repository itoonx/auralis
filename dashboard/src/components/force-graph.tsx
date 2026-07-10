// A small force-directed graph: d3-force does the physics, we render plain SVG so it inherits the theme.
// Nodes are sized by a *capped* degree scale — r = 4 + 2·√deg, clamped to 18px. The old linear 5 + 2·deg
// made the four biggest hubs into r≈115–173 discs that covered two thirds of the canvas; the hub signal
// now lives in the ranked "top hubs" list beside the canvas instead. Drag a node to pin it (double-click
// to unpin), drag the canvas to pan, wheel to zoom, hover to spotlight a neighborhood. Nodes are
// keyboard-focusable (Tab, then Enter to select) — the graph used to be 100% pointer-operated.
import { useEffect, useMemo, useRef, useState } from "react"
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type ForceLink, type Simulation } from "d3-force"
import type { GraphAllEdge } from "@/lib/api"

interface N { id: string; label: string; deg: number; x?: number; y?: number; fx?: number | null; fy?: number | null }
interface L { source: string | N; target: string | N; predicate: string }
type Drag = { kind: "node"; id: string } | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }

const idOf = (v: string | N) => (typeof v === "string" ? v : v.id)
const short = (s: string, n = 22) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const clampK = (k: number) => Math.min(5, Math.max(0.25, k))
// The radius cap that kills the giant discs — collide mirrors it so the layout stays honest too.
const radius = (deg: number) => Math.min(18, 4 + 2 * Math.sqrt(deg))

export function ForceGraph({ edges, selected, focus, onSelect, className }: {
  edges: GraphAllEdge[]
  selected?: string
  /** Center the view on this node — bumped by the find box / hubs list, NOT by canvas clicks (recentering
      under the cursor would yank the view the user is already looking at). */
  focus?: { seq: number; key: string } | null
  onSelect?: (key: string) => void
  className?: string
}) {
  // The canvas fills whatever box the page gives it. The viewBox tracks the measured pixel size (1 svg
  // unit = 1 css px), so pointer math stays exact — a fixed viewBox + w-full used to letterbox and skew
  // drag coordinates whenever the card wasn't exactly 760px wide.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 760, h: 520 })
  const W = size.w, H = size.h
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: Math.max(200, r.width), h: Math.max(200, r.height) }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // When edges change mid-run (a new finding landed), rebuild the node list but seed each surviving node
  // from its previous position — incl. fx/fy, so pins survive — and only genuinely new nodes swing into
  // place. Without this every refresh re-randomized the whole layout. Idempotent, so StrictMode's
  // double-invoke is harmless.
  const prev = useRef<Map<string, N>>(new Map())
  const { nodes, links } = useMemo(() => {
    const map = new Map<string, N>()
    const deg = new Map<string, number>()
    const bump = (key: string, label: string) => {
      if (!map.has(key)) map.set(key, { ...prev.current.get(key), id: key, label, deg: 0 })
      deg.set(key, (deg.get(key) ?? 0) + 1)
    }
    const ls: L[] = []
    for (const e of edges) {
      bump(e.subj_key, e.subject)
      bump(e.obj_key, e.object)
      ls.push({ source: e.subj_key, target: e.obj_key, predicate: e.predicate })
    }
    for (const [k, d] of deg) map.get(k)!.deg = d
    prev.current = map
    return { nodes: [...map.values()], links: ls }
  }, [edges])

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    const link = (a: string, b: string) => { if (!m.has(a)) m.set(a, new Set()); m.get(a)!.add(b) }
    for (const l of links) { link(idOf(l.source), idOf(l.target)); link(idOf(l.target), idOf(l.source)) }
    return m
  }, [links])

  // Label budget: small graphs label everything; big ones label only the hubs (plus hover/selection),
  // otherwise 300+ labels turn the canvas into noise.
  const labelMin = useMemo(() => {
    if (nodes.length <= 40) return 0
    const degs = nodes.map((n) => n.deg).sort((a, b) => b - a)
    return degs[Math.min(14, degs.length - 1)] ?? 0
  }, [nodes])

  const simRef = useRef<Simulation<N, L> | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const [, tick] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })

  useEffect(() => {
    const sim = simRef.current
    if (!sim) {
      const s = forceSimulation<N>(nodes)
        .force("link", forceLink<N, L>(links).id((d) => d.id).distance(72).strength(0.5))
        .force("charge", forceManyBody().strength(-260))
        .force("center", forceCenter(W / 2, H / 2))
        .force("collide", forceCollide<N>().radius((d) => radius(d.deg) + 5))
      s.on("tick", () => tick((n) => n + 1))
      simRef.current = s
    } else {
      // Live update: reuse the running simulation and reheat *gently* (alpha 0.2). Rebuilding at alpha 1
      // every poll made the whole layout thrash for seconds each tick during a run.
      sim.nodes(nodes)
      ;(sim.force("link") as ForceLink<N, L>).links(links)
      sim.alpha(0.2).restart()
    }
  }, [nodes, links])
  useEffect(() => () => { simRef.current?.stop(); simRef.current = null }, [])
  // Follow container resizes: re-aim the centering force and nudge the layout toward the new middle.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    sim.force("center", forceCenter(W / 2, H / 2))
    sim.alpha(0.08).restart()
  }, [W, H])

  const toVB = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }

  // wheel zoom, kept anchored under the cursor. Native listener so preventDefault actually stops page zoom.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const vb = toVB(e)
      setView((v) => {
        const k = clampK(v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
        const dx = (vb.x - v.x) / v.k, dy = (vb.y - v.y) / v.k
        return { k, x: vb.x - dx * k, y: vb.y - dy * k }
      })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // Center the view when the find box / hubs list asks for a node.
  useEffect(() => {
    if (!focus) return
    const n = nodes.find((x) => x.id === focus.key)
    if (n?.x == null || n.y == null) return
    setView((v) => {
      const k = Math.max(v.k, 1.3)
      return { k, x: W / 2 - n.x! * k, y: H / 2 - n.y! * k }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq])

  const onSvgDown = (e: React.PointerEvent) => {
    const vb = toVB(e)
    drag.current = { kind: "pan", sx: vb.x, sy: vb.y, vx: view.x, vy: view.y }
    svgRef.current?.setPointerCapture(e.pointerId)
  }
  const onNodeDown = (n: N) => (e: React.PointerEvent) => {
    e.stopPropagation()
    drag.current = { kind: "node", id: n.id }
    ;(e.target as Element).setPointerCapture(e.pointerId)
    simRef.current?.alphaTarget(0.3).restart()
  }
  const onMove = (e: React.PointerEvent) => {
    const cur = drag.current
    if (!cur) return
    const vb = toVB(e)
    if (cur.kind === "pan") {
      setView((v) => ({ ...v, x: cur.vx + (vb.x - cur.sx), y: cur.vy + (vb.y - cur.sy) }))
    } else {
      const n = nodes.find((x) => x.id === cur.id)
      if (n) { n.fx = (vb.x - view.x) / view.k; n.fy = (vb.y - view.y) / view.k }
    }
  }
  // Releasing keeps fx/fy set — the node stays pinned where it was dropped. Double-click unpins it
  // (a brief alpha kick lets it swing back into the layout).
  const onUp = () => {
    drag.current = null
    simRef.current?.alphaTarget(0)
  }
  const unpin = (n: N) => () => {
    n.fx = null
    n.fy = null
    simRef.current?.alpha(0.3).restart()
  }

  const dim = (id: string) => hover != null && hover !== id && !neighbors.get(hover)?.has(id)
  const tf = `translate(${view.x},${view.y}) scale(${view.k})`

  if (nodes.length === 0) return null
  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`knowledge graph — ${nodes.length} nodes, ${links.length} edges. Tab into it to walk nodes; Enter selects one.`}
        className="h-full w-full cursor-grab touch-none rounded-xl border bg-muted/20 select-none active:cursor-grabbing"
        onPointerDown={onSvgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        <g transform={tf}>
          {links.map((l, i) => {
            const s = l.source as N, t = l.target as N
            if (s?.x == null || t?.x == null || s.y == null || t.y == null) return null
            const active = hover != null && (s.id === hover || t.id === hover)
            const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2
            const show = active || (hover == null && links.length <= 24)
            return (
              <g key={i}>
                <line
                  x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                  stroke="currentColor"
                  className={active ? "text-primary" : "text-border"}
                  strokeOpacity={hover != null && !active ? 0.12 : 0.55}
                  strokeWidth={(active ? 1.6 : 1) / view.k}
                />
                {show && (
                  <text
                    x={mx} y={my - 2 / view.k}
                    textAnchor="middle"
                    className={active ? "fill-primary" : "fill-muted-foreground"}
                    style={{ fontSize: 9 / view.k, pointerEvents: "none" }}
                    opacity={active ? 1 : 0.5}
                  >
                    {l.predicate}
                  </text>
                )}
              </g>
            )
          })}
          {nodes.map((n) =>
            n.x == null ? null : (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                opacity={dim(n.id) ? 0.2 : 1}
                tabIndex={0}
                role="button"
                aria-label={`${n.label} — ${n.deg} connections`}
                onPointerDown={onNodeDown(n)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(n.id) } }}
                onClick={() => onSelect?.(n.id)}
                onDoubleClick={unpin(n)}
                className="cursor-grab outline-none"
              >
                <circle
                  r={radius(n.deg)}
                  className={`fill-primary/80 ${selected === n.id ? "stroke-primary" : n.fx != null ? "stroke-primary/60" : "stroke-background"}`}
                  strokeWidth={(selected === n.id ? 2.5 : 1.5) / view.k}
                />
                {(labelMin === 0 || n.deg >= labelMin || hover === n.id || selected === n.id || (hover != null && neighbors.get(hover)?.has(n.id))) && (
                  <text x={radius(n.deg) + 3} y={4 / view.k} className="fill-foreground" style={{ fontSize: 10 / view.k, pointerEvents: "none" }}>
                    {short(n.label)}
                  </text>
                )}
              </g>
            ),
          )}
        </g>
      </svg>
      <div className="absolute bottom-3 left-3 flex gap-1">
        <button
          type="button"
          onClick={() => setView((v) => ({ ...v, k: clampK(v.k * 1.2) }))}
          className="size-7 rounded-md border bg-background/60 text-sm backdrop-blur-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
          title="zoom in" aria-label="zoom in"
        >+</button>
        <button
          type="button"
          onClick={() => setView((v) => ({ ...v, k: clampK(v.k / 1.2) }))}
          className="size-7 rounded-md border bg-background/60 text-sm backdrop-blur-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
          title="zoom out" aria-label="zoom out"
        >−</button>
        <button
          type="button"
          onClick={() => setView({ x: 0, y: 0, k: 1 })}
          className="h-7 rounded-md border bg-background/60 px-2.5 text-xs backdrop-blur-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
          title="reset view"
        >reset</button>
      </div>
    </div>
  )
}
