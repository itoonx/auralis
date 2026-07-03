// The redundancy measure: how many exploration targets did BOTH workers hit? With a shared brain,
// worker B should skip what worker A already surfaced, so this count drops.
import type { Exploration } from "./runner";

export function redundantCount(a: Exploration[], b: Exploration[]): number {
  const aTargets = new Set(a.map((e) => e.target));
  let dup = 0;
  for (const t of new Set(b.map((e) => e.target))) if (aTargets.has(t)) dup++;
  return dup;
}

export function reductionPct(baselineRedundant: number, sharedRedundant: number): number {
  if (baselineRedundant === 0) return 0;
  return (baselineRedundant - sharedRedundant) / baselineRedundant;
}
