/**
 * Pup Patrol, the demo game for StreamOtter's React hooks: its own repository, served
 * from lontracreek.com, reading this demo's public creek channels. The explainer page
 * (/pup-patrol/) shows the hooks only once the release this site pins has them, per the
 * site's rule that every claim matches the pinned release.
 */

import type { Page } from "./site.ts";

export const GAME = {
  url: "https://lontracreek.com",
  /** The npm release that ships `streamotter/react` (the hooks ship in 1.0.0, the public launch). */
  hooksRelease: "1.0.0",
  channels: [
    { channel: "den", params: "holtId: A", what: "Whether Holt A's pups are home or out. Nothing else: no reach or grid reference, and nothing about the adults." },
    { channel: "reach", params: "reachId: beaver-flats", what: "The Beaver Flats camera trap. A new frame is the trap firing." },
    { channel: "creekOverview", params: "watershed: lontra", what: "Republished every field tick (two seconds), so it is the game's clock; it also sets daylight and weather." }
  ],
  /** What each subscription or connection state does to a round, as the game's src/components/Round.tsx has it. */
  states: [
    { state: "synchronizing", source: "useSubscription", game: "Before the first snapshot: \"Tuning the receiver…\". The round's clock hasn't started." },
    { state: "live", source: "useSubscription", game: "All three live and the connection connected: the round plays." },
    { state: "stale", source: "useSubscription", game: "The field freezes in grey where it was last known and the clock stops: \"Lost the receiver\". Nothing moves on a guess." },
    { state: "resync-required", source: "useSubscription", game: "Still paused, with a Re-tune button that calls that subscription's resync()." },
    { state: "reconnecting", source: "useConnectionState", game: "The signal bars drop and the round pauses, as for a stale channel." },
    { state: "live again", source: "useSubscription", game: "The fresh snapshot wins: the pups go where the den view says, and trap frames taken while paused don't count." }
  ]
} as const;

/**
 * The explainer, as a card for the home page's "See it run" grid and a footer link. It stays
 * out of the header navigation: it's a demo of one feature, not a part of the site.
 */
export const GAME_PAGE: Page = {
  href: "/pup-patrol/",
  label: "Pup Patrol",
  question: "What can I build with the hooks?",
  summary: "A sixty-second game on the creek's live channels, built with StreamOtter's React hooks. Play it at lontracreek.com, then see how it uses each hook.",
  ready: true
};

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

/**
 * The game's own code, excerpted from the pup-patrol repository (file named in each
 * block's first comment). The hooks excerpts are shown once the pinned release has the
 * hooks; DEN_EXCERPT is this demo's own code and is always shown.
 */
export const CODE = {
  provider: `// src/App.tsx: one client for the page, live mode only.
<StreamOtterProvider options={{ origin: config.gatewayOrigin, path: config.gatewayPath, getToken }}>
  {page}
</StreamOtterProvider>

// src/backend.ts: a fresh volunteer badge for every connection, kept in memory.
export async function getToken({ signal }: { signal: AbortSignal }): Promise<string> {
  const response = await fetch(\`\${API_ORIGIN}/api/badge\`, { method: "POST", signal });
  if (!response.ok) throw new Error(\`The field station refused a badge (\${response.status}).\`);
  const body = await response.json() as { token?: unknown };
  if (typeof body.token !== "string") throw new Error("The field station sent no token.");
  return body.token;
}`,
  subscriptions: `// src/streamotter.ts: the hooks, typed from the generated channel types.
import { createStreamOtterHooks } from "streamotter/react";
import type { AppChannels } from "./generated/streamotter.generated.ts";

export const { useSubscription, useConnectionState } = createStreamOtterHooks<AppChannels>();

// src/creek.ts: called by the round on every render. New params objects each time;
// the hooks compare them by value, so the subscriptions stay the same ones all round.
const den = useSubscription("den", { channelVersion: 1, params: { holtId: "A" } });
const reach = useSubscription("reach", { channelVersion: 1, params: { reachId: "beaver-flats" } });
const overview = useSubscription("creekOverview", { channelVersion: 1, params: { watershed: "lontra" } });
const connection = useConnectionState();`,
  states: `// src/creek.ts: anything not live is a problem, and any problem pauses the round.
const problems = [
  ...connection === "connected" ? [] : [\`connection: \${connection}\`],
  ...entries.filter(entry => !entry.result.live).map(entry => \`\${LABELS[entry.channel]}: \${entry.result.state}\`)
];
const live = problems.length === 0;

// The Re-tune button: each resync-required subscription's own resync().
for (const entry of needsResync) entry.result.resync().catch(() => undefined);

// src/components/Round.tsx (simplified): pause on a stale creek or a hidden tab; resume from the fresh snapshot.
useEffect(() => {
  if (!active) pause(game);
  else if (game.phase === "paused" && feed.ready) resync(game, feed.den.pups);
}, [active, feed.ready]);`,
  ticks: `// src/components/Round.tsx (simplified): React hands each creek change to the game in an effect.
useEffect(() => {
  if (active) fieldTick(game, feed.overviewRevision);   // a new overview revision is a field tick
}, [feed.overviewRevision]);
useEffect(() => {
  if (active) setPups(game, feed.den.pups);             // out, or called home
}, [feed.den?.pups]);

// The canvas, outside React: ease toward the tick's targets and draw, every frame.
const loop = (now: number): void => {
  step(game, now - last, input);
  draw(ctx, game, scene);
  last = now;
  frame = requestAnimationFrame(loop);
};`
} as const;

/** The den view, as this demo's simulation publishes it (packages/creek-sim/src/views.ts). */
export const DEN_EXCERPT = `/** Deliberately minimal: a holt's reach would place a denning otter, so it isn't here. */
export interface DenView {
  holtId: HoltId;
  pups: "in-den" | "out" | "none";
}

function denView(world: WorldState, id: HoltId): DenView {
  const litter = OTTERS.find(profile => profile.den === id && profile.pups.length > 0);
  const pups = litter === undefined
    ? "none"
    : litter.pups.every(pup => world.holts[id].occupants.includes(pup)) ? "in-den" : "out";
  return { holtId: id, pups };
}`;

/** Kept for the channel check in the tests: the round's three subscriptions. */
export const HOOKS_EXCERPT = CODE.subscriptions;
