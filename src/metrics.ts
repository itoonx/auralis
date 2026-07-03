// The redundancy measures. For two workers: targets both hit. For a fleet: total re-explorations of a
// target beyond the first worker. With a shared brain, later workers skip what earlier ones surfaced,
// so both drop.
import type { Exploration } from "./runner";

export function redundantCount(a: Exploration[], b: Exploration[]): number {
  const aTargets = new Set(a.map((e) => e.target));
  let dup = 0;
  for (const t of new Set(b.map((e) => e.target))) if (aTargets.has(t)) dup++;
  return dup;
}

// Sum over targets of (workers-that-explored-it - 1): the redundant re-explorations across the fleet.
export function fleetRedundantCount(exploredByWorker: Exploration[][]): number {
  const counts = new Map<string, number>();
  for (const explored of exploredByWorker) {
    for (const t of new Set(explored.map((e) => e.target))) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let redundant = 0;
  for (const c of counts.values()) if (c > 1) redundant += c - 1;
  return redundant;
}

export function reductionPct(baselineRedundant: number, sharedRedundant: number): number {
  if (baselineRedundant === 0) return 0;
  return (baselineRedundant - sharedRedundant) / baselineRedundant;
}
