// Shared vocabulary for the studio: lucide icon + word + accent per event kind (the CLI uses unicode
// glyphs for the same kinds; the studio renders proper icons), and the provenance badge per finding
// source. Icons never travel alone in the UI — every icon is paired with its word, so the feed is
// scannable without a legend.
import {
  ArrowLeftRight,
  Check,
  ChevronsRight,
  MessageCircle,
  Milestone,
  PenLine,
  Play,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"

export interface Kind {
  icon: LucideIcon
  word: string
  cls: string
}

export const KIND: Record<string, Kind> = {
  phase: { icon: Milestone, word: "phase", cls: "text-muted-foreground" },
  intent: { icon: Play, word: "task", cls: "text-blue-400" },
  note: { icon: PenLine, word: "note", cls: "text-violet-400" },
  finding: { icon: Check, word: "finding", cls: "text-emerald-400" },
  dedup: { icon: ArrowLeftRight, word: "dedup", cls: "text-amber-400" },
  overlap: { icon: TriangleAlert, word: "overlap", cls: "text-red-400" },
  repair: { icon: RotateCcw, word: "repair", cls: "text-orange-400" },
  // Session capture + worker tool steps: what the human asked, each tool action, and the answer.
  prompt: { icon: MessageCircle, word: "prompt", cls: "text-sky-400" },
  trace: { icon: ChevronsRight, word: "tool", cls: "text-muted-foreground" },
  answer: { icon: Sparkles, word: "answer", cls: "text-emerald-300" },
}

const FALLBACK: Kind = { icon: ChevronsRight, word: "event", cls: "text-muted-foreground" }
export const kindOf = (k: string): Kind => KIND[k] ?? (k ? { ...FALLBACK, word: k } : FALLBACK)

// Findings carry their provenance — badge per source family (mirrors the trust tiers at the ingress).
export function sourceBadge(source: string): { label: string; cls: string } {
  if (source.startsWith("human")) return { label: "human", cls: "text-sky-300" }
  if (source === "auralis:retro") return { label: "retro", cls: "text-orange-300" }
  if (source === "auralis:decision") return { label: "decision", cls: "text-violet-300" }
  if (source === "auralis:distilled") return { label: "distilled", cls: "text-emerald-300" }
  if (source === "session:assistant") return { label: "assistant", cls: "text-muted-foreground" }
  if (source.startsWith("auralis:worker")) return { label: source.replace("auralis:worker:", "worker·"), cls: "text-muted-foreground" }
  return { label: source || "note", cls: "text-muted-foreground" }
}
