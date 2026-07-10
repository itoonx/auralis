// A small force-directed graph: d3-force does the physics, we render plain SVG so it inherits the theme.
// Nodes sized by degree; drag a node to pin it where you drop it (double-click to unpin), drag the canvas
// to pan, wheel to zoom, hover to spotlight a node's neighborhood (its edges get their predicate
// labelled). No canvas, no wrapper lib.
import { useEffect, useMemo, useRef, useState } from "react"
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation } from "d3-force"
import type { GraphAllEdge } from "@/lib/api"

interface N { id: string; label: string; deg: number; x?: number; y?: number; fx?: number | null; fy?: number | null }
interface L { source: string | N; target: string | N; predicate: string }
type Drag = { kind: "node"; id: string } | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }

const W = 760, H = 520
const idOf = (v: string | N) => (typeof v === "string" ? v : v.id)
const short = (s: string, n = 22) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const clampK = (k: number) => Math.min(5, Math.max(0.25, k))

export function ForceGraph({ edges, onSelect }: { edges: GraphAllEdge[]; onSelect?: (key: string) => void }) {
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

  const simRef = useRef<Simulation<N, L> | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const [, tick] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })

  useEffect(() => {
    const sim = forceSimulation<N>(nodes)
      .force("link", forceLink<N, L>(links).id((d) => d.id).distance(72).strength(0.5))
      .force("charge", forceManyBody().strength(-260))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide<N>().radius((d) => 10 + d.deg * 2))
    sim.on("tick", () => tick((n) => n + 1))
    simRef.current = sim
    return () => { sim.stop() }
  }, [nodes, links])

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
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[520px] select-none touch-none rounded-md border bg-muted/20 cursor-grab active:cursor-grabbing"
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
                onPointerDown={onNodeDown(n)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(null)}
                onClick={() => onSelect?.(n.id)}
                onDoubleClick={unpin(n)}
                className="cursor-grab"
              >
                <circle r={(5 + n.deg * 2)} className={`fill-primary/80 ${n.fx != null ? "stroke-primary" : "stroke-background"}`} strokeWidth={1.5 / view.k} />
                <text x={(8 + n.deg * 2)} y={4 / view.k} className="fill-foreground" style={{ fontSize: 10 / view.k, pointerEvents: "none" }}>{short(n.label)}</text>
              </g>
            ),
          )}
        </g>
      </svg>
      <div className="absolute top-2 right-2 flex gap-1">
        <button
          onClick={() => setView((v) => ({ ...v, k: clampK(v.k * 1.2) }))}
          className="size-6 rounded border bg-background/80 text-xs hover:bg-muted"
          title="zoom in"
        >+</button>
        <button
          onClick={() => setView((v) => ({ ...v, k: clampK(v.k / 1.2) }))}
          className="size-6 rounded border bg-background/80 text-xs hover:bg-muted"
          title="zoom out"
        >−</button>
        <button
          onClick={() => setView({ x: 0, y: 0, k: 1 })}
          className="h-6 px-2 rounded border bg-background/80 text-[11px] hover:bg-muted"
          title="reset view"
        >reset</button>
      </div>
    </div>
  )
}
