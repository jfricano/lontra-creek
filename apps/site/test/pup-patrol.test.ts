import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CODE, DEN_EXCERPT, GAME, GAME_PAGE, HOOKS_EXCERPT, hooksIn } from "../src/pup-patrol.ts";
import { RELEASE } from "../src/site.ts";

const page = readFileSync(new URL("../src/pages/pup-patrol.astro", import.meta.url), "utf8");

test("the hooks are shipped from 1.0.0, a preview in its prereleases, and absent before", () => {
  assert.equal(hooksIn("0.2.0-rc.1"), "not yet");
  assert.equal(hooksIn("0.2.0"), "not yet");
  assert.equal(hooksIn("1.0.0-rc.1"), "preview");
  assert.equal(hooksIn("1.0.0"), "shipped");
  assert.equal(hooksIn("1.1.3"), "shipped");
  assert.equal(hooksIn("2.0.0-rc.1"), "shipped");
  assert.throws(() => hooksIn("latest"), /Not a release version/);
});

test("the explainer page shows hook code only when the pinned release has the hooks", () => {
  // The page decides from the installed release; this holds that wiring in place.
  assert.match(page, /const hooks=hooksIn\(RELEASE\);/);
  assert.match(page, /\{hooks==="not yet" && <p class="notice"/);
  const blocks = [...page.matchAll(/(\{hooks!=="not yet" && )?<Code code=\{(\w+(?:\.\w+)?)\}/g)];
  for (const key of Object.keys(CODE)) {
    const block = blocks.find(match => match[2] === `CODE.${key}`);
    assert.ok(block, `CODE.${key} is on the page`);
    assert.ok(block[1], `CODE.${key} waits for a release with the hooks`);
  }
  assert.ok(blocks.some(match => match[2] === "DEN_EXCERPT" && match[1] === undefined), "the den view is this demo's own code, always shown");
});

test("the excerpt reads exactly the channels the page lists", () => {
  for (const { channel } of GAME.channels) assert.match(HOOKS_EXCERPT, new RegExp(`useSubscription\\("${channel}"`));
  assert.equal([...HOOKS_EXCERPT.matchAll(/useSubscription\("/g)].length, GAME.channels.length);
});

test("the docs page links to the explainer", () => {
  assert.match(readFileSync(new URL("../src/pages/docs.astro", import.meta.url), "utf8"), /href="\/pup-patrol\/"/);
});

test("the den excerpt matches the simulation's code", () => {
  const views = readFileSync(new URL("../../../packages/creek-sim/src/views.ts", import.meta.url), "utf8");
  for (const line of ["const litter = OTTERS.find(profile => profile.den === id && profile.pups.length > 0);", "litter.pups.every(pup => world.holts[id].occupants.includes(pup))", "return { holtId: id, pups };", "holtId: HoltId;"]) {
    assert.ok(DEN_EXCERPT.includes(line) && views.includes(line), line);
  }
});

test("streamotter.dev links to the game: a home card and the footer, not the header navigation", () => {
  const home = readFileSync(new URL("../src/pages/index.astro", import.meta.url), "utf8");
  const base = readFileSync(new URL("../src/layouts/Base.astro", import.meta.url), "utf8");
  assert.match(home, /const explorePages = \[\.\.\.LISTED_PAGES\.filter\([^\n]*\), GAME_PAGE\];/, "a card in the home page's See it run grid");
  assert.match(base, /<a href=\{GAME_PAGE\.href\}>\{GAME_PAGE\.label\}<\/a>/, "the footer's Explore list");
  const newTab = String.raw`target="_blank" rel="noopener">`;
  assert.ok(base.includes(`<a href={GAME.url} ${newTab}Play Pup Patrol ↗<span class="sr-only"> (opens in a new tab)</span></a>`), "the footer's Project list, straight to lontracreek.com in a new tab");
  assert.equal(GAME.url, "https://lontracreek.com");
  assert.equal(GAME_PAGE.href, "/pup-patrol/");
  assert.ok(page.includes(`href={GAME.url} ${newTab}Play Pup Patrol at lontracreek.com ↗<span class="sr-only"> (opens in a new tab)</span>`), "the explainer's play button, in a new tab");
  assert.ok(![...`${base}${page}`.matchAll(/href=\{GAME\.url\}[^>]*>/g)].some(match => !match[0].includes('target="_blank"')), "every link to the game opens a new tab");
});
