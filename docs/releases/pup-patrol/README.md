# Pup Patrol backend and explainer

**Status: built on branch `feat/pup-patrol-92ggxb`, not merged.** Lontra Creek's main is frozen until the phase-two site is in production, and demo rollouts wait for the owner. Written October 6, 2026 (Pacific).

[Pup Patrol](https://github.com/orca-solutions/pup-patrol) is the demo game for StreamOtter's React hooks (StreamOtter V1.3, npm `1.1.0`): its own repository, served from lontracreek.dev, reading this demo's creek. Its plan is in that repository (`docs/PLAN.md`, moved from StreamOtter PR #68), with the design in `docs/DESIGN.md`. This page covers what changes here.

## Release notes

### A public `den` channel

- New channel `den`, params `{ holtId }` (the `HoltParams` schema), payload `DenStatus`: `{ holtId, pups }`, where `pups` is `in-den`, `out` (with their mother), or `none` (a holt without a litter, Holt B). State delivery, overflow `resync`, version 1, on the `field` source.
- Published by the field station beside `holt` for both holts, on a new topic, `field.dens`. The field station creates it (its Kafka user already has Create on `field.*`); the gateway already reads `field.*`.
- Readable by any signed-in visitor. It withholds more than the plan sketched: no reach or grid reference (a holt's reach would place a denning otter, whose reach the public otter view withholds), and no `occupied`, occupants, or entry and exit times, which would say when an adult is in the den. Whether the pups are out is already public: the mother's otter view says when they are with her. The restricted `holt` channel is unchanged.
- Kept off Failure Lab benches, like `holt` (`LabChannels`, `CREEK_TOPICS`).
- A world checkpoint written before `den` existed restores with `den` published from the restored tick (`restore` in `packages/creek-sim/src/world.ts`), so the hosted world keeps its seed and generation; no generation bump is needed.
- `docs/PLAN.md` lists the channel and topic; the generated types in the field station and the site are regenerated.

### A second allowed origin, for the game, off until switched on

- `GAME_ORIGIN` is Pup Patrol's switch, read by both the field station and the gateway's handlers (`apps/field-station/src/game-origin.ts`). Unset or empty is off. In production it can only be `https://lontracreek.dev`, because that is the game origin the gateway's baked config allows; anything else refuses to start.
- `streamotter.production.json`: the gateway's `allowedOrigins` is `https://streamotter.dev` and `https://lontracreek.dev`. While the switch is off, the handlers refuse every handshake from the game's origin (`refusedOrigins` in `kafka-handlers.ts`), so the baked origin opens nothing.
- Field station, when the switch is on: CORS, without credentials, on `GET /api/config`, `GET /api/status` and `POST /api/badge` only. A badge for the game is always a new volunteer and sets no cookie; the game keeps the token in memory (the plan's recommended session handling). The Lab, the workbench sandbox and notebooks still accept only `SITE_ORIGIN`, which stays one exact origin.
- `deploy/compose.yaml` passes `GAME_ORIGIN` to both services, default empty (off). `docs/SHARED_HOST_READINESS.md` lists it. Caddy needs no change: only the Lab and sandbox routes match `Origin` there.
- Development: `GAME_ORIGIN` defaults to the game's Vite dev server (`http://localhost:5173`, `http://127.0.0.1:5173`), and the development gateways (`streamotter.json`, `streamotter.fixture.json`, `npm run dev`, `npm run dev:kafka`) allow it, so the game can run against a local backend.
- `deploy/test/kafka-acl-probes.mjs` includes `field.dens`.

### A recording for the game

- `apps/field-station/scripts/pup-patrol-fixture.ts` (`npm run fixture:pup-patrol`) writes `apps/field-station/fixtures/pup-patrol.json`: 90 field ticks of Holt A's `den`, the Beaver Flats `reach` and `creekOverview`, from the first window of the seeded creek in which the pups go out and then come home and the trap fires at least five times. The game copies it for its local creek, its tests and its offline fallback. A test fails if the committed file is out of date or a record doesn't fit its schema.

### The explainer page

- `/pup-patrol/` on streamotter.dev, linked from the Docs page's "On this site" (not a new navigation item). It says what the game reads and what to watch for, and links to lontracreek.dev. It shows the hooks code only when the release the site pins has them (`hooksIn(RELEASE)` in `apps/site/src/pup-patrol.ts`): before `1.1.0` it says they arrive in `1.1.0`; for a `1.1.0` prerelease it shows them labeled as a preview.

## Tests

- `packages/creek-sim/test/sim.test.ts`: the den view's shape and values over ten study days, that it carries nothing that places the den (no reach, grid reference or adult), and restoring an older checkpoint.
- `apps/field-station/test/server.test.ts`: the game origin's three routes, the volunteer-only badge without a cookie, refusals for notebooks and the Lab, and `GAME_ORIGIN` parsing (off unless set; in production only the gateway's origin).
- `apps/field-station/test/kafka-handlers.test.ts`: the gateway refuses the game's origin while the switch is off, and every gateway config allows the game's origin, so the switch alone decides.
- `apps/field-station/test/lab.test.ts`: `field.dens` stays off benches.
- `apps/field-station/test/field-station.test.ts`: the recording is current and valid.
- `apps/site/test/pup-patrol.test.ts`: the hooks gate and the excerpt.

## Before it goes live

1. Phase two in production and the main freeze lifted; the owner merges.
2. `streamotter@1.1.0` on npm; the site and field station pins move to it in the same release (the explainer then shows the hooks).
3. The game deployed to lontracreek.dev (Cloudflare Pages and DNS, owner's go).
4. The image rolled out through the shared-host procedure. Rolling it out alone changes nothing for the game; `GAME_ORIGIN=https://lontracreek.dev` in `/etc/apps/lontra/lontra.env` (and a restart of the field station and gateway) turns it on, once the game is live at step 3.
5. Hosted acceptance: a round on lontracreek.dev against demo.streamotter.dev, including a real connection drop.
