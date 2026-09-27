import type { CreekOverview } from "../generated/streamotter.generated.ts";

/** A rolling twelve-tick comparison; no predicted or interpolated readings. */
export class FlowHistory {
  private samples: { tick: bigint; stations: CreekOverview["stations"] }[] = [];
  add(revision: bigint, stations: CreekOverview["stations"]): { stationId: string; change: number } | null {
    if (this.samples.at(-1)?.tick === revision) return null;
    this.samples.push({ tick: revision, stations });
    this.samples = this.samples.filter(sample => revision - sample.tick <= 12n);
    const first = this.samples[0];
    if (first === undefined || this.samples.length < 2) return null;
    return stations.map(station => ({ stationId: station.stationId,
      change: station.flowCfs - (first.stations.find(old => old.stationId === station.stationId)?.flowCfs ?? station.flowCfs)
    })).sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0] ?? null;
  }
}

export function chapterFromHash(hash: string): number {
  const value = /^#chapter-([1-6])$/.exec(hash)?.[1];
  return value === undefined ? 1 : Number(value);
}

/** A hidden tab expires even if synthetic activity events continue to arrive. */
export class IdleDeadline {
  private lastActivity: number;
  private hiddenAt: number | null = null;
  constructor(now: number, readonly timeoutMs = 600_000) { this.lastActivity = now; }
  activity(now: number): void { if (this.hiddenAt === null) this.lastActivity = now; }
  visibility(hidden: boolean, now: number): void {
    if (hidden && this.hiddenAt === null) this.hiddenAt = now;
    if (!hidden) this.hiddenAt = null;
  }
  expired(now: number): boolean { return now - (this.hiddenAt ?? this.lastActivity) >= this.timeoutMs; }
}
