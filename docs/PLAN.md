# Lontra Creek: the StreamOtter site and live demo

September 25, 2026 · Phase 0 (foundation) in progress · Visual blueprint: [StreamOtter Site Blueprint](https://claude.ai/artifact/6Zfj7bgjuXaSShKDQ5LJuv)

This repository holds StreamOtter's public home site and its live demo. The demo is a fictional river-otter study at Lontra Creek whose data moves through real Kafka, a real StreamOtter gateway, and the real browser SDK. The site's job is to take a developer from "what is this" to "I watched it survive a failure" to `npm install streamotter` in one visit.

This document owns the site's scope, the demo's behavior and operating rules, and the launch criteria. StreamOtter's own behavior is defined by the library, not here.

## Ground rules

**Independent of the library repository.** This repository uses StreamOtter only as a published npm package, at an exact version, installed with npm the way any developer would. It never links to the library's source: no git submodules, workspace links, local paths, or checkouts, including for tests and docs. A problem the demo finds becomes an issue on the library, and this repository upgrades after a release ships (release candidates count). The one shared asset is a copy of the logo in `assets/`.

**Every claim matches the pinned release.** Behavior, code samples, screenshots, and limits describe the version in `package.json`. No invented adoption counts, testimonials, capacity claims, or performance numbers. A number says where it was measured. Future plans stay visibly separate from shipped features.

**Fiction is labeled.** Lontra Creek, its field station, its people, and its otters are made up. The pipeline is real. Any page that could blur the two says which is which. A recording is labeled as a recording, and the site never silently substitutes an animation for the live demo.

**Visitors can't hurt each other or the host.** Visitors can't upload code, choose topics, send arbitrary payloads, connect their own broker, or reach the broker, the stores, management APIs, or the workbench. Scenario actions are a fixed set. Failure scenarios run only on isolated, leased benches (see the Failure Lab).

## The story

Lontra Creek is a 14.2 km watershed from Alder Spring to the Marrow River, named for *Lontra canadensis*, the North American river otter. A field station monitors it:

| Instrument | IDs | Reports |
| --- | --- | --- |
| Gauge stations | LC-01 Cedar Riffle, LC-02 Kestrel Bend, LC-03 Slate Canyon, LC-04 Heron Marsh | Stage (ft), flow (cfs), water temperature (°C), dissolved oxygen (mg/L), turbidity (NTU) |
| Telemetry receivers | One per reach | Detections of tagged otters |
| Camera traps | Cedar Riffle, Beaver Flats, Heron Marsh | Frames: species, count, time |
| Holt monitors | Holt A (Beaver Flats), Holt B (Heron Marsh) | Den occupancy and exact grid reference |

The cast: **Pebble** (LO-07, adult female, home range Kestrel Bend to Slate Canyon, dens at Holt A with her pups), **Sprout and Skipper** (untagged pups, seen only on camera traps), **Birch** (LO-03, adult male, ranges the whole creek), and **Juniper** (LO-11, yearling female, dispersing downstream and sometimes leaving the watershed).

Den sites are restricted to researchers, as real studies restrict them to prevent disturbance. The public otter channel withholds an otter's location while it is at a den; only the restricted holt channel has the grid reference. That split follows StreamOtter's rule that every reader of one channel instance receives the same public state, so different audiences get different channels.

## Pages

| Route | Visitor's question | Content |
| --- | --- | --- |
| `/` | Why would I use this? | The live creek hero on a real subscription (a labeled recording when the demo is down), three-step integration with type-checked code, the live-or-stale promise, a workbench preview, Get started and Try the demo. |
| `/field-station` | What does it look like running? | The guided walkthrough (below), the creek map, and an under-the-hood panel: states, epochs, revisions, and the code behind each step. |
| `/lab` | What happens when it breaks? | The Failure Lab (below). |
| `/playground` | What's it like to set up? | Edit a `streamotter.json` with the real validator running in the browser; generated types once the library can generate in a browser; a labeled console that subscribes to the field station; recorded CLI sessions. |
| `/workbench` | What tools do I get? | A tour of Connect, Define, Preview, Inspect, and Export from screenshots Playwright captures from the workbench installed from npm, plus a recorded session. |
| `/when-it-breaks` | How does it fail, exactly? | Each failure mode: the state it produces, the `StreamError` the application receives, whether it retries, handling code, and an interactive state diagram. |
| `/docs` | How do I build with it? | A map of the documentation linking to the guides on GitHub and the package pages on npm. The site doesn't copy them. |
| `/releases` | What works in this version? | The pinned version, its verified support matrix and limits as published by the library, and links to its changelog. |

## The guided walkthrough (`/field-station`)

About three minutes, validated by a timed walkthrough before launch. Visitors start as a volunteer with an anonymous, short-lived session.

1. **Dawn survey.** Open the Kestrel Bend gauge: authorizing, synchronizing, snapshot, live.
2. **The creek rises.** Readings arrive as full states with increasing revisions. Storms follow the simulation's schedule; this chapter points at whichever station is changing fastest.
3. **Into Slate Canyon.** The visitor's own connection drops. Views turn stale while the creek keeps moving. Reconnecting brings fresh snapshots and a note listing the revisions that were not replayed.
4. **The protected holt.** As a volunteer, subscribe to Holt A. The gateway answers `FORBIDDEN` and sends no data.
5. **Hand over the tablet.** Sign in as the field biologist (a different subject). Existing subscriptions close with `UNAUTHENTICATED`; the new identity subscribes fresh and Holt A opens.
6. **Log a sighting.** The app writes the visitor's notebook, publishes it to Kafka, and the visitor's notebook view updates through the gateway.

## The Failure Lab (`/lab`)

A fixed pool of three benches, not one per visitor. Each bench has its own gateway process, topic, and consumer group, is leased to one visitor for five minutes, and is reset between leases. When every bench is busy, the page shows the visitor's place in line and the local-run instructions.

| Scenario | What the visitor does | What they see |
| --- | --- | --- |
| Fouled sensor | Remove LC-03's calibration table; the bench's map handler throws on the next reading. | The source pauses at that record, views go stale, and the trace shows `map` failing with `HANDLER_FAILED`. After restoring the table and resuming, the same record is processed; nothing is skipped. |
| Flash flood takes the relay | Cut the network path between the bench gateway and Kafka. | Stale after the inactivity window, then live again soon after the path is restored. Timings shown are measured on this deployment. |
| Laptop on a satellite link | A simulated client on the bench stops acknowledging frames. | That client is disconnected after the receipt timeout; the visitor's view keeps flowing and the source never waits. |
| Relay restart | Restart the bench gateway. | Reconnecting, fresh snapshot, live. |

Benches run `streamotter dev` so their traces can be read. Their management API listens only on the bench's loopback interface; the field station app reads traces server-side and exposes a redacted feed. The field station itself runs `streamotter start` in production mode. The relay cut needs a per-bench network proxy in front of Kafka; it is the one Lab mechanism not yet prototyped.

## Architecture

```
visitor ──HTTPS──▶ CloudFront + S3            static site: pages, docs map, playground, recordings
   │
   └──HTTPS/WSS──▶ demo host (one EC2 instance, Docker Compose)
                     Caddy (TLS, rate limits, port 443 only)
                       ├─ /streamotter/*  ─▶ gateway: `streamotter start`, production mode, from npm
                       ├─ /api/*          ─▶ field station app: sessions, scenarios, simulation, snapshot API
                       └─ /lab/*          ─▶ Failure Lab benches (dev-mode gateways)
                     Kafka 4.1.2, KRaft single node, TLS + SCRAM-SHA-512, private
                   DynamoDB: visitor sessions and notebooks (TTL), simulation checkpoints
                   GitHub Actions: builds images and deploys; no Docker needed on a laptop
```

- **One gateway** is StreamOtter V1's supported topology, so the demo runs what its docs recommend, behind Caddy.
- **Kafka 4.1.2** is the broker version StreamOtter's Kafka tests use, with TLS and SCRAM as in its production check. MSK Serverless requires IAM authentication, which V1 doesn't support.
- **The static site deploys separately**, so pages, the docs map, and the playground stay up when the demo host is down. The live panels then show an unavailable state, a labeled recording, and local-run instructions.

## Data flow and consistency

The simulation (`packages/creek-sim`) is deterministic: the world is a pure function of its seed and tick. The field station app is the only writer.

- **Ticks and time.** One tick is five simulated minutes. In the hosted demo a tick happens every two real seconds, so a simulated day lasts 9.6 minutes. The target tick comes from the wall clock, so a restarted app computes the same world and continues where it should be.
- **Revisions.** A shared-world entity's revision is `generation × 10¹² + tick`, where tick is when it last changed. The generation increases whenever the simulation's logic changes or the world is reset, so revisions only move forward even when a new version recomputes history differently. Without that, a replayed tick with different data would be a `REVISION_CONFLICT` and pause the source.
- **Write, then publish.** Each tick, the app updates the state its snapshot API serves, then publishes the changed entities to Kafka, keyed by entity ID so each one stays on one partition. A snapshot is therefore never older than anything already published. After a crash, the app republishes the current state of every entity; equal revisions with equal data are dropped as duplicates. A catch-up after downtime publishes only the latest state, which is correct for full-state channels.
- **Snapshots.** The gateway's snapshot handler reads the app's internal snapshot API with a service token. Visitor notebooks live in DynamoDB and are read with strongly consistent reads, written with a conditional check that the revision increases, and expire through TTL (reads also check expiry, because TTL deletion runs late).
- **Checkpoints.** The app checkpoints the world hourly so a restart replays at most an hour of ticks.

Channels: `station` (stationId), `otter` (otterId), `reach` (reachId, camera traps), `holt` (holtId, researchers only), `creekOverview` (watershed), and `notebook` (observerId, its owner only). Topics: `field.gauges`, `field.telemetry`, `field.cameras`, `field.holts`, `creek.overview`, and `field.notebooks`, in two sources so a notebook problem can't pause the world.

## Limits and operations

Record these on the real host before launch: concurrent visitors (start at 300), subscriptions per visitor (12), scenario actions (one per second), session lifetime (30 minutes), idle expiry (10 minutes), Kafka retention, and gateway queue limits. Two sessions must not be able to read or affect each other's notebook. Keep deployment, rollback, health checks, and a budget alarm with the infrastructure code. The operator is the repository owner.

Estimated cost: about $33–42 a month on AWS on-demand prices (EC2 t4g.medium, public IPv4, 30 GB gp3, DynamoDB on-demand, CloudFront and S3, Route 53), plus the domain. Confirm with the AWS pricing calculator.

## Phases

| Phase | Delivers | Needs |
| --- | --- | --- |
| 0. Foundation | This repository, the plan, design tokens, the site scaffold, the creek simulation with tests, and the field station's StreamOtter configuration validated with the published CLI. | Nothing further. |
| 1. Static site | Home with a recorded hero, When it breaks, Workbench tour, Playground validator, the docs map, Releases. Deployable on its own. | Domain. |
| 2. Field station | Production gateway, app, simulation, DynamoDB; the six chapters; containers; staging on AWS. | AWS account and budget; local Kafka. |
| 3. Failure Lab | Bench pool, relay-cut proxy, slow client, redacted trace feed. | Decision: before or after launch. |
| 4. Launch | The criteria below, then publication. | Owner's go-ahead. |

## Launch criteria

- Every route and call to action works; install commands and code samples are checked against the pinned `streamotter` version.
- The hosted walkthrough passes on the real deployment, including session isolation, expiry, cleanup, denial, reconnect, and the busy and unavailable states.
- Keyboard navigation, visible focus, readable contrast, screen-reader labels, reduced motion, and narrow screens work on every page. Supported browsers are named and checked.
- Titles, descriptions, social previews, a sitemap, canonical URLs, and a useful not-found page exist. Page load and demo startup are measured on a named device and network profile.
- HTTPS, WebSocket connectivity through the proxy, secrets handling, quotas, health monitoring, rollback, and the fallback recording are verified on staging. Operating limits, budget, and operator are recorded here.

## Open decisions

- Domain. `streamotter.com` was registered on May 8, 2026 (GoDaddy, Cloudflare DNS); the owner is confirming whether it's theirs. `streamotter.io` and `streamotter.org` appeared unregistered on September 25.
- AWS account and monthly ceiling (proposed budget alarm: $60).
- Whether the Failure Lab ships with the launch or after it.
- Whether this repository is public on GitHub, and when it is first pushed.
