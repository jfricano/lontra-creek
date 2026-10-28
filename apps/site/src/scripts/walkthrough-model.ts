import type { CreekOverview } from "../generated/streamotter.generated.ts";

/** A rolling twelve-tick comparison; no predicted or interpolated readings. */
export class FlowHistory {
  private samples: { tick: bigint; stations: CreekOverview["stations"] }[] = [];
  /** Records one overview revision (a repeat of the newest is ignored) and returns the station whose flow changed most, in cfs, over the last twelve ticks, or null until there are two samples. */
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

/** The walkthrough chapter (1 to 6) a `#chapter-N` hash names; 1 for any other hash. */
export function chapterFromHash(hash: string): number {
  const value = /^#chapter-([1-6])$/.exec(hash)?.[1];
  return value === undefined ? 1 : Number(value);
}

/** A hidden tab expires even if synthetic activity events continue to arrive. */
export class IdleDeadline {
  private lastActivity: number;
  private hiddenAt: number | null = null;
  /** How long without counted activity before the deadline passes, in milliseconds; ten minutes by default. */
  readonly timeoutMs: number;
  /** Starts counting from `now`, on the same clock as the later calls. */
  constructor(now: number, timeoutMs = 600_000) { this.lastActivity = now; this.timeoutMs = timeoutMs; }
  /** Counts activity at `now`, unless the tab is hidden. */
  activity(now: number): void { if (this.hiddenAt === null) this.lastActivity = now; }
  /** Records the tab being hidden or shown; while it is hidden, activity doesn't count. */
  visibility(hidden: boolean, now: number): void {
    if (hidden && this.hiddenAt === null) this.hiddenAt = now;
    if (!hidden) this.hiddenAt = null;
  }
  /** Whether `timeoutMs` has passed since the last activity that counted. */
  expired(now: number): boolean { return now - Math.min(this.hiddenAt ?? this.lastActivity, this.lastActivity) >= this.timeoutMs; }
}
