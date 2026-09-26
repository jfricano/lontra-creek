<p align="center"><img src="assets/streamotter-logo.png" alt="StreamOtter" width="360"></p>

# Lontra Creek

StreamOtter's home site and live demo. Lontra Creek is a fictional river-otter study: a simulated watershed with gauge stations, tagged otters, camera traps, and protected den sites. Its data moves through real Kafka, a real StreamOtter gateway, and the real browser SDK.

This project uses StreamOtter the way any application does: the published [`streamotter`](https://www.npmjs.com/package/streamotter) package from npm, at an exact version. It has no other connection to the [StreamOtter repository](https://github.com/jfricano/StreamOtter).

> **Status: Phase 0, foundation.** The simulation and the plan exist; the site and the hosted demo don't yet. See [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/creek-sim` | The simulation: a deterministic watershed, weather, gauges, otters, and camera traps, and the channel views the field station publishes |
| `apps/field-station` | The demo application: StreamOtter configuration and handlers, the simulation runner, sessions, and scenarios |
| `apps/site` | The public site (planned) |
| `docs/PLAN.md` | Scope, story, architecture, operating rules, phases, and launch criteria |

## Develop

Node.js 24 or later.

```bash
npm install
npm test
npm run typecheck
```

## The simulation in brief

One tick is five study minutes; the hosted demo runs a tick every two seconds, so a study day lasts 9.6 minutes. The world is a pure function of its seed and tick and checkpoints as JSON, so a restarted field station recomputes exactly where it left off. Storm runoff routes downstream through the four gauges with travel time, so a crest reaches LC-01 first and LC-04 hours later. Otters rest through midday, come out at dawn and dusk, shelter from high water, and den in their holts. While an otter is in a den, its public channel withholds where it is.

Lontra Creek, its field station, and its otters are made up. The pipeline is real.

## License

[MIT](LICENSE) © 2026 Orca Solutions.
