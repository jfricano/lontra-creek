/**
 * Pup Patrol, the demo game for StreamOtter's React hooks: its own repository, served
 * from lontracreek.dev, reading this demo's public creek channels. The explainer page
 * (/pup-patrol/) shows the hooks only once the release this site pins has them, per the
 * site's rule that every claim matches the pinned release.
 */

export const GAME = {
  url: "https://lontracreek.dev",
  /** The npm release that ships `streamotter/react` (the hooks ship in 1.0.0, the public launch). */
  hooksRelease: "1.0.0",
  channels: [
    { channel: "den", params: "holtId: A", what: "Whether Holt A's pups are home or out. Nothing else: no reach or grid reference, and nothing about the adults." },
    { channel: "reach", params: "reachId: beaver-flats", what: "The Beaver Flats camera trap. A new frame is the trap firing." },
    { channel: "creekOverview", params: "watershed: lontra", what: "Republished every field tick (two seconds), so it is the game's clock; it also sets daylight and weather." }
  ]
} as const;

function parse(version: string): { core: [number, number, number]; prerelease: boolean } {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (match === null) throw new Error(`Not a release version: ${version}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined };
}

/**
 * Whether a StreamOtter release has the hooks: "shipped" from 1.0.0, "preview" for a
 * 1.0.0 prerelease, "not yet" before that.
 */
export function hooksIn(release: string): "shipped" | "preview" | "not yet" {
  const { core, prerelease } = parse(release);
  const [major, minor, patch] = parse(GAME.hooksRelease).core;
  const order = core[0] - major || core[1] - minor || core[2] - patch;
  if (order > 0) return "shipped";
  if (order < 0) return "not yet";
  return prerelease ? "preview" : "shipped";
}

/** How the game reads the creek, as it is in the game's src/creek.ts. Shown once the pinned release has the hooks. */
export const HOOKS_EXCERPT = `import { createStreamOtterHooks, StreamOtterProvider } from "streamotter/react";
import type { AppChannels } from "./generated/streamotter.generated.ts";

export const { useSubscription, useConnectionState } = createStreamOtterHooks<AppChannels>();

// In the round, on every render. New params objects each time; the hooks compare
// them by value, so the subscriptions stay the same ones all round.
const den = useSubscription("den", { channelVersion: 1, params: { holtId: "A" } });
const reach = useSubscription("reach", { channelVersion: 1, params: { reachId: "beaver-flats" } });
const overview = useSubscription("creekOverview", { channelVersion: 1, params: { watershed: "lontra" } });
const connection = useConnectionState();

// Anything not live pauses the round on the last known creek.
const live = connection === "connected" && den.live && reach.live && overview.live;`;
