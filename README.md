<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/site/public/brand/streamotter-lockup-dark.svg">
    <img src="apps/site/public/brand/streamotter-lockup.svg" alt="StreamOtter" width="240">
  </picture>
</p>

# Lontra Creek

StreamOtter's home site and live demo. Lontra Creek is a fictional river-otter study: a simulated watershed with gauge stations, tagged otters, camera traps, and protected den sites. Its data moves through real Kafka, a real StreamOtter gateway, and the real browser SDK.

This project uses StreamOtter the way any application does: the published [`streamotter`](https://www.npmjs.com/package/streamotter) package from npm, at an exact version. It has no other connection to the [StreamOtter repository](https://github.com/jfricano/StreamOtter).

> **Status: the production stack is proven in CI; not yet hosted.** The simulation, the field station, and the home page with a live panel run locally (`npm run dev`). The production stack (Kafka over TLS with SCRAM, the gateway, the field station, and Caddy, in containers) passes a full-stack test on every pull request. The site now includes the guided field station, playground, workbench tour, reference pages, and a labeled recorded fallback. The Failure Lab and deployment candidate are undergoing integration checks; public hosting remains pending. See [docs/PLAN.md](docs/PLAN.md), [docs/DEPLOYMENT_PLAN.md](docs/DEPLOYMENT_PLAN.md), and [docs/HOSTING.md](docs/HOSTING.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/creek-sim` | The simulation: a deterministic watershed, weather, gauges, otters, and camera traps, and the channel views the field station publishes |
| `apps/field-station` | The demo application: StreamOtter configuration and handlers, the simulation runner that publishes to Kafka, the site API, and sessions |
| `apps/site` | The public site: Astro, with the live panel on the home page |
| `deploy` | The demo host: one container image, the Compose stack (Kafka, the gateway, the field station, Caddy), its secret and certificate scripts, and the full-stack test CI runs |
| `docs/PLAN.md` | Scope, story, architecture, operating rules, phases, and launch criteria |
| `docs/DEPLOYMENT_PLAN.md` | The engineering work from here to launch, in order |
| `docs/HOSTING.md` | The owner's account and server checklist |
| `docs/TEAM_PLAN.md` | How the team of agents builds what remains: roles, process, branches, backlog, and sprints |

## Develop

Node.js 24 or later.

```bash
npm install
npm test
npm run typecheck
npm run dev        # field station + site at http://127.0.0.1:4321
```

`npm run dev` runs the field station without Kafka, replaying the simulation through a StreamOtter gateway in development mode, one study tick every two seconds, with the workbench at http://127.0.0.1:7401 (its one-time token is printed at startup).

Browser checks run with `npm run test:browser`. To verify connection loss and recovery against built production bundles using the same fixture backend:

```bash
LONTRA_BROWSER_MODE=production npm run test:browser -- e2e/home.spec.ts e2e/walkthrough.spec.ts
```

`node scripts/dev.mjs --preview` builds and serves that fixture-backed production preview for manual checks. It uses the same port variables below.

Four environment variables move the whole dev stack to a different port block, so more than one can run at once on the same machine:

| Variable | Default | What it moves |
| --- | --- | --- |
| `LONTRA_SITE_PORT` | 4321 | The Astro dev server |
| `LONTRA_GATEWAY_PORT` | 7400 | The dev gateway (also used to build its allowed origins from `LONTRA_SITE_PORT`) |
| `LONTRA_WORKBENCH_PORT` | 7401 | The StreamOtter workbench |
| `LONTRA_API_PORT` | 7402 | The field station's small site API, and the site's `/api` proxy target |

```bash
LONTRA_SITE_PORT=4331 LONTRA_GATEWAY_PORT=7430 LONTRA_WORKBENCH_PORT=7431 LONTRA_API_PORT=7432 npm run dev
```

To exercise chapter six with real Kafka and persistent private notebooks, install Kafka 4.1.2 and JDK 21 locally, then run:

```bash
KAFKA_HOME=/path/to/kafka JAVA_HOME=/path/to/jdk npm run dev:kafka
```

This command downloads nothing. It starts a loopback-only development broker, the field station, gateway, and site. It preserves Kafka logs and simulation checkpoints under `.local/kafka-dev` across normal stops/restarts. Set `LONTRA_KAFKA_DATA_DIR` to choose another directory. Besides the site/gateway/API ports above, it uses `LONTRA_INTERNAL_PORT` (7410), `LONTRA_KAFKA_PORT` (19092), and `LONTRA_KAFKA_CONTROLLER_PORT` (19093). This mode has no Failure Lab or workbench; it uses plaintext loopback Kafka and is not a production deployment. Stop with Ctrl-C; a stale `running.lock` may be removed only after confirming the prior stack has stopped.

In production the field station runs the simulation on the wall clock and publishes to Kafka (`apps/field-station/src/server/main.ts`), and the gateway is `streamotter start` with compiled handlers (`npm run build -w @lontra-creek/field-station`). [`deploy/compose.yaml`](deploy/compose.yaml) runs them with Kafka 4.1.2 and Caddy; [`.github/workflows/stack.yml`](.github/workflows/stack.yml) shows how to bring the stack up with throwaway secrets and test it from outside.

## The simulation in brief

One tick is five study minutes; the hosted demo runs a tick every two seconds, so a study day lasts 9.6 minutes. The world is a pure function of its seed and tick and checkpoints as JSON, so a restarted field station recomputes exactly where it left off. Storm runoff routes downstream through the four gauges with travel time, so a crest reaches LC-01 first and LC-04 hours later. Otters rest through midday, come out at dawn and dusk, shelter from high water, and den in their holts. While an otter is in a den, its public channel withholds where it is.

Lontra Creek, its field station, and its otters are made up. The pipeline is real.

## License

[MIT](LICENSE) © 2026 Orca Solutions.
