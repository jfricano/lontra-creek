# Shared UI components

September 26, 2026 · The site's shared UI pieces: where each lives, what it becomes, which lane builds it, and the rules every page follows · Owner: `lead`

Every page that shows StreamOtter at work repeats a few pieces: the state chip, code panels, the fiction and recording labels, notices such as the unavailable state, and the live cards. Built once, they keep the site's promises from [PLAN.md](../PLAN.md#ground-rules) in one place: states named exactly as the SDK names them, fiction and recordings labeled, nothing silently substituted for the live demo. `lead` owns this inventory and reviews every change to a shared component; the lane named below builds and maintains each one. When a sprint needs a shared file edited by someone else, the owner makes the change or the orchestrator reassigns it for that sprint (TEAM_PLAN.md section 7).

"Today" means `main` on September 26 (after #9). Two open pull requests move things: #13 (F.3) moves the live panel's SDK logic from `live-creek.ts` into `field-client.ts`, `field-views.ts`, `field-cards.ts`, and `field-log.ts` under `apps/site/src/scripts/`, with the same DOM; #10 (F.4) gives each route its own page and a `PagePlaceholder.astro`. Paths below are under `apps/site/src/`.

## Summary

| Piece | Today | Becomes | Owner | First needed by |
| --- | --- | --- | --- | --- |
| State chip | `.chip[data-state]` in `styles/global.css`; used in `pages/index.astro` and `components/LiveCreek.astro`, set by `scripts/live-creek.ts` | `components/StateChip.astro`, and the chip setter in `field-cards.ts` (#13) | `fe-walk` | E1.1c under-the-hood panel; E4.1 state diagram (Sprint 1) |
| Code panel | `<Code theme="night-owl">` in `pages/index.astro`, fed by `snippets/`; `pre.astro-code` in `global.css`; the copy button in `index.astro`; a hand-written `<pre>` in `LiveCreek.astro` | `components/CodePanel.astro`, `components/CopyCommand.astro`, and `snippets/commands.ts` | `fe-content` | E4.1, E4.2, E4.3 (Sprint 1) |
| Fiction label | The footer line in `layouts/Base.astro`; `.panel-note` under the live panel in `pages/index.astro` | `components/FictionNote.astro` | `fe-content` | E1.1b walkthrough shell (Sprint 1) |
| Recording label | Nothing yet | `components/RecordingLabel.astro`, required by every recording player | `fe-content` | E4.6 recorded fallback (Sprint 2) |
| Notices | `.lc-unavailable` in `LiveCreek.astro`; `.soon` in `[section].astro` (`PagePlaceholder.astro` in #10) and `index.astro` | `components/Notice.astro` and `components/LocalRun.astro` | `fe-content`; `fe-walk` adopts them in `LiveCreek.astro` | E3.1 busy and unavailable states (Sprint 2); the walkthrough (Sprint 1) |
| Live card | `.lc-card` markup in `LiveCreek.astro`; its behavior in `live-creek.ts` (`field-cards.ts` in #13) | `components/LiveCard.astro` and `field-cards.ts` | `fe-walk` | E1.2 chapters (Sprint 1); E3.1 `/lab` (Sprint 2) |
| Theme, brand, and chrome | Design tokens and type in `styles/global.css`; the brand files in `assets/brand/` and `public/`; `layouts/Base.astro`, `pages/404.astro`, `components/PagePlaceholder.astro` | Unchanged (section 7) | design | Every page |

The SDK log (`.lc-log` in `LiveCreek.astro`, `field-log.ts` in #13) is the sixth shared piece; `fe-walk` owns it, and the Lab's trace feed follows its line format (section 6).

## 1. State chip

**Today.** `.chip` and one rule per state in `styles/global.css`, covering all eight `SubscriptionState` values: `live`; `idle`, `authorizing`, and `synchronizing` (the sync colors); `stale`; `resync-required`; `failed` and `closed`. Static chips in the home page's "Every view is in a state you can name" section; live ones in the live panel's cards, where `live-creek.ts` sets `data-state` and the text on each SDK state event. `.live-creek` redefines `--live`, `--sync`, `--stale`, `--resync`, and `--failed` for its dark panel, so the same rules work on both backgrounds.

**Becomes.** `components/StateChip.astro` with a `state` prop typed `SubscriptionState | ConnectionState` from `streamotter/client`, rendering `<span class="chip" data-state={state}>{state}</span>`, plus the setter in `field-cards.ts` for chips that change at run time. The styles stay in `global.css`, since script-updated chips need global rules. New: `ConnectionState` styles, so the Lab and the walkthrough can show the connection with the same chip: `connected` with the live colors, `connecting` with sync, `reconnecting` with stale, `auth-required` with resync, and `idle` and `closed` as for subscriptions.

**Owner.** `fe-walk`, extracted in Sprint 1 with E1.1c; `fe-walk` edits the chip block of `global.css` that sprint. In Sprint 0, F.3 keeps the DOM identical.

**Rules.**

- The text is the exact SDK state string: `stale`, never "offline" or "paused". A reason (`SOURCE_UNAVAILABLE`, `UNAUTHENTICATED`) goes next to the chip, never inside it.
- `data-state` is the only styling hook, and the hook tests select on.
- A chip shows `live` only after the SDK reported `live` for that view. Nothing infers or animates it.
- Color is never the only signal: the text is always there and readable.
- Colors come from the tokens, never literals, so chips work on light surfaces and dark panels.
- Changes are announced through the page's one polite live region, and only transitions worth hearing (to `live`, `stale`, or `failed`), not every step.

## 2. Code panels

**Today.** The home page's three steps and quickstart use `<Code theme="night-owl">` from `astro:components`: the `station` channel read from the real `apps/field-station/streamotter.json`, and excerpts of `snippets/handlers.ts` and `snippets/subscribe.ts`, which are type-checked against the pinned release and cut by `snippets/excerpt.ts` between `// snippet:start` and `// snippet:end`. `pre.astro-code` in `global.css` sets the shape and `--code-bg`. The install button (`[data-copy]`) and its script live in `index.astro`. The live panel's unavailable state writes its local-run commands by hand in a `<pre>`.

**Becomes.** `components/CodePanel.astro` (props: `code`, `lang`, and an optional `caption` naming the file or command), `components/CopyCommand.astro` (the install button, reusable), and `snippets/commands.ts`, the one source for command text shown on the site: install, quickstart, and the local-run commands (which L.2 may change).

**Owner.** `fe-content`, in Sprint 1 with E4.1–E4.3; it owns `pages/` and `index.astro`.

**Rules.**

- TypeScript shown on the site comes from a file under `snippets/` that the site's typecheck compiles against the pinned release, never from a string in a page.
- Configuration shown comes from the real project files or passes `validateProjectConfig` in a test.
- Install commands match the pinned release. `npm install streamotter` installs npm's `latest` tag, which is `0.1.0-rc.3` (checked September 26, 2026 with `npm view streamotter dist-tags`). If `latest` ever moves off the pinned version, pages pin it (`streamotter@${RELEASE}`); `research` checks at every release (R.1).
- The `night-owl` theme and `--code-bg` background, in light and dark mode alike; long lines scroll sideways and never wrap.
- Copy buttons say "Copy", then "Copied", or "Select and copy" when the clipboard is refused.
- A code panel is never live. Output shown next to code, such as a CLI session, is a recording and carries a recording label.

## 3. Fiction and recording labels

**Today.** Fiction: the footer's "Lontra Creek, its field station, and its otters are fictional. The data pipeline is real." (`Base.astro`, `.fiction`) and the note under the home page's live panel (`.panel-note`). Recordings: none yet; E4.6 adds the first.

**Becomes.** `components/FictionNote.astro` (a short line and a longer variant) and `components/RecordingLabel.astro`, whose props are all required: `recordedAt` (a date), `where` (for example "a local run" or "staging, demo.streamotter.app"), and `what` (for example "the live panel's SDK events, replayed through the same UI"). Every recording player renders one, so a recording without its date and place fails the typecheck.

**Owner.** `fe-content` (E4.6, and the recordings on `/playground`, `/workbench`, and `/lab`).

**Rules.**

- Any page or panel showing Lontra Creek data has a fiction note next to the data, not only in the footer: the creek, the field station, its people, and its otters are made up; the pipeline is real.
- A recording is always labeled "Recording", with its date and where it was made, next to the replayed content, visible without interaction, and in its accessible name.
- A recording never borrows live styling: no pulsing dot and no live border on its frame. Its chips replay the recorded states inside the labeled frame.
- The site never silently substitutes a recording or an animation for live data. When live data fails, the unavailable notice says so first; a labeled recording may then play.
- A timing in a recording or on a page says where it was measured.

## 4. Notices, including the unavailable state

**Today.** The live panel's unavailable state, `.lc-unavailable` in `LiveCreek.astro`, shown by `data-status="unavailable"` on the panel when `/api/config` fails or the gateway hasn't connected within 15 seconds (the SDK keeps trying). It says the demo isn't answering and that the rest of the site works, hides the connection controls, shows how to run the demo locally, and clears when the SDK connects. Placeholder pages and the home page's explore cards show an "In progress" badge (`.badge-soon` in `global.css` on placeholders; the explore cards' own `.soon` until the home page's design story).

**Becomes.** `components/Notice.astro` with `kind` `"unavailable" | "busy" | "in-progress" | "info"`, a heading, and a slot, and `components/LocalRun.astro`, the local-run instructions from `snippets/commands.ts`, which both the unavailable and busy notices include.

**Owner.** `fe-content` builds both; `fe-walk` switches `LiveCreek.astro` to them the next time it edits the panel in Sprint 1, keeping the `data-status="unavailable"` hook.

**Rules.**

- A notice appears on evidence only: a failed request, or a stated timeout such as the 15 seconds above. It clears on evidence too: the SDK connecting, or the Lab answering.
- Unavailable: say plainly what isn't answering, say the rest of the site works, hide controls that can't work, and show the local-run instructions.
- Busy (the Lab, every bench leased): the visitor's place in line, a way to leave it, and the local-run instructions ([lab-api.md](lab-api.md#4-leases-and-the-queue)). The Lab is unavailable when `GET /api/lab/status` fails, says `enabled: false`, or lists no working bench.
- One polite announcement per notice; a `data-status` hook for tests.
- Unavailable and busy notices use the stale colors (`--stale`, `--stale-bg`), because the demo they describe is out of reach. "In progress" never does: it uses the neutral `.badge-soon`, so an unfinished page can't be mistaken for a stale view.

## 5. Live cards

**Today.** Three `.lc-card` articles in `LiveCreek.astro`: a header (instrument ID, name, state chip), three values, and a footer (revision and age). `live-creek.ts` (`field-cards.ts` in #13) binds each to one subscription: it sets the chip, adds `is-stale` (dimmed values, a silt pattern), flashes the card on each snapshot, highlights changed values, shows the revision as `r<tick>` with the full revision in the `title`, updates the age every half second, ignores an update no newer than what's shown, and, after a reconnect, notes which revisions weren't replayed.

**Becomes.** `components/LiveCard.astro` (props: the ID, the name, and the fields: label, `data-v` key, unit), with `field-cards.ts` for the behavior. The walkthrough uses it in Sprint 1 and `/lab` in Sprint 2.

**Owner.** `fe-walk`. `fe-content` uses it on `/lab` and asks `fe-walk` for changes.

**Rules.**

- One card, one subscription. Every value on it comes from that subscription's SDK events: nothing interpolated, estimated, or invented.
- Stale keeps the last values visible, dimmed, with the chip saying `stale` and the age saying "stale · last update Ns ago". Values are never blanked.
- A snapshot flashes the card; an update highlights the changed value. The global reduced-motion rule turns both off.
- The revision shown never goes backwards. The short form is the tick within the generation (`revision mod 10¹²`, `shortRevision` in `field-views.ts`), with the full revision in the `title`.
- After a reconnect's fresh snapshot, the card or its panel says the revisions in between weren't replayed: StreamOtter V1 delivers the current state, not history.
- `failed` shows the error code next to the chip.

## 6. Test hooks

These `data-*` attributes are the contract between the pages and the browser tests (F.5 and later); changing one needs `qa`'s agreement. On the live panel: `data-live-creek`, `data-status`, `data-connection`, `data-network`, `data-overview`, `data-card`, `data-state`, `data-v`, `data-rev`, `data-age`, `data-log`, `data-announce`, `data-note`, `data-drop`, `data-restore`, `data-clock`, and `data-source`; on the home page, `data-copy`. New shared components add their own `data-*` hooks rather than relying on classes, and every hook a test uses is listed here by the pull request that adds it.

On `/lab/` ([lab-api.md section 12](lab-api.md#12-the-source-failures-track-v11), V1.1 W4): `data-lab-tracks`, `data-lab-track-link`, `data-lab-track`, `data-lab-scenario`, `data-lab-scenario-link`, `data-lab-selected-mark`, `data-lab-availability` (with `data-state`: `existing`, `pending`, `available`, `unavailable`), `data-lab-availability-text`, `data-lab-start`, `data-lab-capability`, and the incident panel's `data-lab-incident`, `data-lab-incident-empty`, `data-lab-incident-reason`, `data-lab-incident-body`, `data-lab-incident-evidence`, `data-lab-incident-source`, `data-lab-incident-recovery`, `data-lab-incident-evaluation`, `data-lab-incident-next`, `data-lab-incident-detail`, and `data-lab-incident-steps`. Unavailable scenario actions use `aria-disabled="true"` with `aria-describedby` on the visible reason, so they stay focusable and explained.

V1.1 site content (W8): on the home page, `data-v11-panel` (the planned-V1.1 panel and its **Try source failures** link to `/lab/#source-failures`); on `/field-station/`, `data-walk-next` (the optional "Next: handle a bad reading" link to `/lab/?scenario=fouled-sensor#source-failures`); on `/when-it-breaks/`, `data-planned-policies` (the planned policy matrix and record-disposition lifecycle); on `/releases/`, `data-release-site`, `data-release-library`, `data-release-demo`, and `data-release-service` (with `data-service`: `checking`, `answered`, `unreachable`), whose `data-release-service-status` and `data-release-service-lines` report only what the field station answered. Planned StreamOtter behavior is always labeled as planned and names the installed version it is not in.

The SDK log's lines (`field-log.ts`) are a time since the page started, a highlighted subject (a view's label, `connection`, `network`), and what the SDK reported. The Lab's trace feed uses the same line shape, with the trace's stage and outcome as the subject.

## 7. Theme, brand, and chrome

**Owner.** Design (the brand-foundation story, `feat/site-brand-foundation`): the design tokens and type in `styles/global.css` except the chip block, which stays with `fe-walk`; the brand files, which `scripts/brand-assets.mjs` generates from `assets/streamotter-brand.svg` and `assets/streamotter-logo-transparent.png` (never edit the outputs by hand); `layouts/Base.astro`, `pages/404.astro`, and `components/PagePlaceholder.astro`. The look of the chips, the code theme, notices, stale cards, and the recording label is design's to set in tokens; their markup, props, behavior rules, and `data-*` hooks stay with the lanes above.

**Rules.**

- Colors come from tokens. The bright brand blues (`--azure`, `--splash`, `--signal`) are fills and display accents, never text or white-label buttons on light grounds: text uses `--azure-ink` or `--accent`, and primary buttons use `--button-bg` and `--button-ink`.
- Status colors mean status. Cyan (`--signal`, `--live`) means live, amber (`--stale`) means stale; neither decorates.
- The brandmark is inlined from `assets/brand/` (`lockup-horizontal.svg` in the header, `lockup-stacked.svg` in the footer, `mark.svg` on the 404 and placeholder pages) with `class="brand"` and `aria-hidden="true"`; the link or heading around it carries the name. Its S and "Stream" follow `--brand-ink` and its whiskers `--brand-whisker`, so one file serves both schemes. Set its height in CSS with `aspect-ratio` from the viewBox, so nothing shifts as it loads.
- The detailed swimming-otter logo appears once on the site, as the home page's hero illustration. Everywhere small or repeated uses the flat brandmark.
- `SITE.launched` in `site.ts` is false until launch. Navigation, the footer, and the 404 page list `LISTED_PAGES`: every page before launch, only ready pages after.
