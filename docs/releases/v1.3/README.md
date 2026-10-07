# V1.3 — Pup Patrol, a React game on lontracreek.dev

**Status: planned, not approved for build.** Decided by the owner on October 6, 2026 (Pacific): the demo for StreamOtter's React hooks ([StreamOtter V1.3](https://github.com/jfricano/StreamOtter/blob/main/docs/releases/v1.3/README.md), shipping as `streamotter@1.1.0` after the `1.0.0` launch) is a small React game, **Pup Patrol**, on its own domain, **lontracreek.dev**, linked from streamotter.dev. This document is the plan. The build waits for the owner's go, for the phase-two site to be in production, and for `1.1.0` (or `1.1.0-rc.1`) on npm. The concept comparison that led here is kept in [CONCEPTS.md](CONCEPTS.md).

## What it is

A sixty-second arcade round, replayable. You are Pebble (LO-07). Sprout and Skipper, her untagged pups, wander out of Holt A toward the Beaver Flats camera trap; you herd them back before the trap fires. Score is pups home at the bell, minus every frame the trap took of them. The high score lives in the browser.

The creek is real. The pups' wandering and the trap's timing are not scripted by the game: they come from the live `reach` camera-trap view at Beaver Flats and from a new public view of Holt A's occupancy, through the same Kafka path and gateway as the field station page. The game is a side quest: a fun thing on its own domain that happens to be the clearest possible demo of the hooks.

### What it shows off

| StreamOtter behavior | How the player feels it |
| --- | --- |
| `useSubscription` renders live data | Pups and the trap move with the channel; the under-the-hood drawer shows each subscription's state and revision. |
| `stale` | A stale `reach` freezes the trap mid-flash; stale den data hides the pups. The round pauses with "lost the receiver", and resumes on `live`. Last-known positions stay, greyed. |
| Connection drop and reconnect (`useConnectionState`) | A signal bar. On reconnect, the fresh snapshot visibly resets the pups: the game never guesses what happened while it was out. |
| `resync-required` | A "re-tune" button that calls `resync()`. |
| Audience rule | Holt A's grid reference is withheld from the public view the game reads; the den is drawn at a reach, not a point. |
| Mount and unmount | A round mounts its subscriptions and the end screen unmounts them; the drawer's count goes to zero. StrictMode in development leaves exactly one per component. |
| Hooks in an animation loop | A 60 fps canvas re-renders freely while three subscriptions stay put: params by value, no resubscribe. |

Everything is read-only: no new write anywhere, visitors send nothing to the broker, the fiction is labeled on the page, and when the demo backend is down the page shows a labeled recording of a round rather than a silent substitute, as streamotter.dev's home page does.

## Where it lives

**A new workspace in this repository, `apps/pup-patrol`**, the owner's default pending a different call. It shares the simulation's types (`@lontra-creek/sim` for reach and otter identifiers), the release-pin guard, CI and the deploy pipeline, and it keeps one place for everything that reads the demo gateway. A separate repository would read as a cleaner side quest but adds a third repo to pin, build and deploy for one page.

- A small React app built with Vite (not Astro: the game is one interactive screen, not a content site), pinning `streamotter@1.1.0` exactly from npm, per the ground rules. No link to the StreamOtter checkout.
- Deployed as a static site to lontracreek.dev on Cloudflare Pages, the way streamotter.dev is, by a second `site` workflow job or a copy of it.
- It reads the production gateway at demo.streamotter.dev and the field station's `/api/session` for a volunteer badge, exactly as the site does.

## What changes in this repository

| Change | Notes |
| --- | --- |
| `apps/pup-patrol` | New Vite + React workspace; `streamotter@1.1.0` and `react` pinned; game canvas, the three hooks calls, the under-the-hood drawer, the recorded fallback. |
| New public view: `den` | Holt A's occupancy without the grid reference: `{ holtId, reachId, occupied, pupsAtDen: boolean, lastEntry, lastExit }`. A new `DenStatus` schema and `den` channel (params `{ holtId }`, state, overflow `resync`) in `streamotter.json`, `streamotter.fixture.json` and `streamotter.production.json`; a `den` view in `packages/creek-sim/src/views.ts`, published by the field station beside `holt`; generated types regenerated. The restricted `holt` channel is untouched. |
| Second allowed origin | Today production accepts one exact `SITE_ORIGIN` (`config.ts` refuses a list; `deploy/Caddyfile` matches one literal `Origin`), and the gateway's baked-in `allowedOrigins` lists only streamotter.dev. The game needs `https://lontracreek.dev` added in all three places: `allowedOrigins` in `streamotter.production.json`, a `SITE_ORIGINS` list accepted by `config.ts` and the CORS code, and a Caddy matcher for either origin. This is the one backend change, and it is part of the game's rollout, not a separate release. |
| Session cookie | The volunteer badge is `SameSite=Strict`, which a page on lontracreek.dev cannot send to demo.streamotter.dev. Options, decided at build time: the game calls `/api/session` and holds the token in memory for the round (simplest, no cookie), or the badge becomes `SameSite=None; Secure` for the game's origin only. The first is recommended. |
| Fixture mode | A fixture scenario where the pups leave the den and the trap fires on a schedule, so the game runs under `npm run dev` without Kafka and Playwright can drive a round. |
| Tests | `creek-sim` unit tests for the `den` view (never carries `gridRef`); field-station contract check includes `den`; an e2e test that loads the game, plays a round in fixture mode, and forces a stale state (the relay-cut proxy from the Lab, or a mocked drop) and checks the pause and resume. |
| Docs | This folder's implementation plan, acceptance and release notes on the V1.1 pattern; the [site plan](../../PLAN.md) notes the second domain; `README.md` layout table. |

## The page on streamotter.dev

One page, in the site's existing Docs family rather than a new navigation item (the design thread's layout for Docs applies): what Pup Patrol is, a short recording, the three hooks it uses with the real code from `apps/pup-patrol`, what to watch for (pull your network cable; see the round pause), and the link out to lontracreek.dev. It describes the pinned version and shows the hooks only once `1.1.0` is published, per the site's "every claim matches the pinned release" rule. The site's own `streamotter` pin moves to `1.1.0` in the same release.

## Sequencing

1. Phase-two site in production (the current main freeze lifts). Nothing from this plan merges before that.
2. StreamOtter builds and publishes V1.3 as `1.1.0-rc.1`, then `1.1.0`. The game may pin the rc for a preview, as the site pinned `0.2.0-rc.1`.
3. The owner's go for the build; the game gets its own thread and an implementation plan in this folder.
4. Build order inside the repository: the `den` view and channel (fixture first, then Kafka), the second-origin change, the game, the explainer page, then hosted acceptance on the real deployment including the stale and reconnect states.
5. Domain: lontracreek.dev on Cloudflare DNS, Pages project, and the origin added to the demo host's configuration through the shared-host procedure with devops.

## Open decisions

1. The repository: `apps/pup-patrol` here (recommended, assumed above) or a separate repository.
2. Session handling for the second origin: token in memory (recommended) or a cross-site cookie.
3. Whether the explainer page waits for `1.1.0` final or goes up with the rc preview, labeled as such.
4. Name and route of the explainer page on streamotter.dev.
