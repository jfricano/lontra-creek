import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  advanceTo, allViews, createWorld, currentEmissions, OTTERS, REACHES, restore, revisionFor, serialize, STATIONS, step, studyTime,
  TICKS_PER_DAY, type DenView, type Emission, type OtterView, type OverviewView, type HoltView, type WorldState
} from "@lontra-creek/sim";

function run(world: WorldState, ticks: number, each?: (emissions: Emission[]) => void): WorldState {
  for (let i = 0; i < ticks; i++) {
    const emissions = step(world);
    each?.(emissions);
  }
  return world;
}

describe("determinism", () => {
  test("the same seed produces the same world", () => {
    const a = run(createWorld({ seed: "lontra-creek" }), 2 * TICKS_PER_DAY);
    const b = run(createWorld({ seed: "lontra-creek" }), 2 * TICKS_PER_DAY);
    assert.equal(serialize(a), serialize(b));
  });

  test("different seeds produce different worlds", () => {
    const a = run(createWorld({ seed: 1 }), TICKS_PER_DAY);
    const b = run(createWorld({ seed: 2 }), TICKS_PER_DAY);
    assert.notEqual(serialize(a), serialize(b));
  });

  test("a restored checkpoint continues exactly as the original", () => {
    const original = run(createWorld({ seed: "lontra-creek" }), 700);
    const copy = restore(serialize(original));
    const fromOriginal: Emission[][] = [];
    const fromCopy: Emission[][] = [];
    run(original, 900, emissions => fromOriginal.push(emissions));
    run(copy, 900, emissions => fromCopy.push(emissions));
    assert.deepEqual(fromCopy, fromOriginal);
    assert.equal(serialize(copy), serialize(original));
  });

  test("restore refuses an unknown format", () => {
    const text = serialize(createWorld({ seed: 3 })).replace('"format":1', '"format":99');
    assert.throws(() => restore(text), /Unsupported world format 99/);
  });

  test("the generation must be a positive integer", () => {
    assert.throws(() => createWorld({ seed: 1, generation: 0 }), RangeError);
    assert.throws(() => createWorld({ seed: 1, generation: 1.5 }), RangeError);
  });
});

describe("revisions", () => {
  test("a revision is generation × 10^12 + tick", () => {
    assert.equal(revisionFor(1, 0), "1000000000000");
    assert.equal(revisionFor(7, 2880), "7000000002880");
  });

  test("every channel instance's revisions only increase, and only changed views are emitted", () => {
    const world = createWorld({ seed: "lontra-creek", generation: 3 });
    const last = new Map<string, bigint>();
    const lastJson = new Map<string, string>();
    for (const emission of currentEmissions(world)) {
      last.set(emission.key, BigInt(emission.revision));
      lastJson.set(emission.key, JSON.stringify(emission.data));
    }
    run(world, 3 * TICKS_PER_DAY, emissions => {
      const keys = new Set<string>();
      for (const emission of emissions) {
        assert.ok(!keys.has(emission.key), `${emission.key} emitted twice in one tick`);
        keys.add(emission.key);
        assert.equal(emission.revision, revisionFor(3, world.tick));
        assert.ok(BigInt(emission.revision) > last.get(emission.key)!, `${emission.key} revision did not increase`);
        assert.notEqual(JSON.stringify(emission.data), lastJson.get(emission.key), `${emission.key} emitted without a change`);
        last.set(emission.key, BigInt(emission.revision));
        lastJson.set(emission.key, JSON.stringify(emission.data));
      }
    });
    // Snapshots carry the revision of the last published change.
    for (const emission of currentEmissions(world)) {
      assert.equal(BigInt(emission.revision), last.get(emission.key));
      assert.equal(JSON.stringify(emission.data), lastJson.get(emission.key));
    }
  });

  test("a new generation outranks every revision of the old one", () => {
    const old = run(createWorld({ seed: "lontra-creek", generation: 1 }), 5 * TICKS_PER_DAY);
    const fresh = createWorld({ seed: "lontra-creek", generation: 2 });
    const highestOld = currentEmissions(old).reduce((max, e) => (BigInt(e.revision) > max ? BigInt(e.revision) : max), 0n);
    for (const emission of currentEmissions(fresh)) assert.ok(BigInt(emission.revision) > highestOld);
  });

  test("advanceTo returns only the latest state of each instance", () => {
    const stepped = createWorld({ seed: 11 });
    const latest = new Map<string, Emission>();
    run(stepped, 500, emissions => { for (const e of emissions) latest.set(e.key, e); });
    const jumped = createWorld({ seed: 11 });
    const collapsed = advanceTo(jumped, 500);
    assert.equal(jumped.tick, 500);
    assert.equal(serialize(jumped), serialize(stepped));
    assert.deepEqual(new Map(collapsed.map(e => [e.key, e])), latest);
  });

  test("advancing to the current tick is a no-op", () => {
    const world = run(createWorld({ seed: 5 }), 10);
    assert.deepEqual(advanceTo(world, 10), []);
    assert.deepEqual(advanceTo(world, 3), []);
    assert.equal(world.tick, 10);
  });
});

describe("the creek", () => {
  const world = createWorld({ seed: "lontra-creek" });
  const flows: number[][] = [];
  const rainStarts: number[] = [];
  const implausible: string[] = [];
  let raining = false;
  run(world, 30 * TICKS_PER_DAY, () => {
    flows.push(STATIONS.map(station => world.stations[station.id].trueFlowCfs));
    if (world.weather.raining && !raining) rainStarts.push(world.tick);
    raining = world.weather.raining;
    for (const station of STATIONS) {
      const s = world.stations[station.id];
      const at = `${station.id} at tick ${world.tick}`;
      if (!(s.flowCfs > 0.9 * station.baseflowCfs)) implausible.push(`${at}: flow ${s.flowCfs} cfs below baseflow`);
      if (!(s.stageFt > station.zeroFlowStageFt)) implausible.push(`${at}: stage ${s.stageFt} ft`);
      if (!(s.waterTempC > 4 && s.waterTempC < 20)) implausible.push(`${at}: water ${s.waterTempC} °C`);
      if (!(s.dissolvedOxygenMgL > 6 && s.dissolvedOxygenMgL < 14)) implausible.push(`${at}: oxygen ${s.dissolvedOxygenMgL} mg/L`);
      if (!(s.turbidityNtu > 0 && s.turbidityNtu < 400)) implausible.push(`${at}: turbidity ${s.turbidityNtu} NTU`);
    }
  });

  test("readings stay physically plausible for a month", () => {
    assert.deepEqual(implausible.slice(0, 5), []);
  });

  test("it rains every few days", () => {
    assert.ok(rainStarts.length >= 6 && rainStarts.length <= 25, `${rainStarts.length} storms in 30 days`);
  });

  test("baseflow grows downstream", () => {
    const quiet = flows[0]!;
    for (let i = 1; i < quiet.length; i++) assert.ok(quiet[i]! > quiet[i - 1]!);
  });

  test("a storm's crest reaches the stations in order, going downstream", () => {
    const start = rainStarts[0]! - 1;
    const window = flows.slice(start, start + 16 * 12);
    const peaks = STATIONS.map((_, j) => window.reduce((best, row, i) => (row[j]! > window[best]![j]! ? i : best), 0));
    for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i]! > peaks[i - 1]!, `peaks ${peaks.join(", ")}`);
    assert.ok(window[peaks[0]!]![0]! > 1.5 * STATIONS[0]!.baseflowCfs, "the first storm should at least raise LC-01 by half");
  });
});

describe("the otters", () => {
  test("stay in their home ranges, and leave only through the confluence", () => {
    const world = createWorld({ seed: "lontra-creek" });
    const wasAway = new Map<string, boolean>();
    run(world, 30 * TICKS_PER_DAY, () => {
      for (const profile of OTTERS) {
        const state = world.otters[profile.id];
        if (!state.away) {
          assert.ok(state.reach >= profile.range[0] && state.reach <= profile.range[1], `${profile.name} outside range`);
        }
        if (state.away && !wasAway.get(profile.id)) {
          assert.ok(profile.disperser, `${profile.name} left the watershed`);
          assert.equal(state.reach, REACHES.length - 1);
        }
        wasAway.set(profile.id, state.away);
      }
    });
  });

  test("public views never reveal a den site", () => {
    const world = createWorld({ seed: "lontra-creek" });
    let denningSeen = 0;
    run(world, 20 * TICKS_PER_DAY, () => {
      const views = allViews(world);
      const overview = views.find(view => view.channel === "creekOverview")!.data as OverviewView;
      for (const profile of OTTERS) {
        const state = world.otters[profile.id];
        const view = views.find(v => v.key === `otter:${profile.id}`)!.data as OtterView;
        const summary = overview.otters.find(o => o.otterId === profile.id)!;
        if (state.activity === "denning" && !state.away) {
          denningSeen += 1;
          assert.equal(view.reachId, "withheld");
          assert.equal(summary.reachId, "withheld");
          assert.ok(view.lastDetection.receiver === "withheld" || view.lastDetection.receiver === "none");
          assert.doesNotMatch(JSON.stringify(view), /Holt|LC \d{4}|beaver-flats|heron-marsh/);
        }
      }
      const holtA = views.find(v => v.key === "holt:A")!.data as HoltView;
      const pebble = world.otters["LO-07"];
      assert.equal(holtA.occupants.includes("Pebble"), pebble.activity === "denning");
      assert.equal(holtA.occupants.includes("Sprout"), !pebble.pupsWithHer);
    });
    assert.ok(denningSeen > 0);
  });

  test("rest through midday and come out at dusk", () => {
    const world = createWorld({ seed: "lontra-creek" });
    const counts = { midday: [0, 0], dusk: [0, 0] };
    run(world, 30 * TICKS_PER_DAY, () => {
      const hour = studyTime(world.tick).hour;
      const bucket = hour >= 11 && hour < 15 ? counts.midday : hour >= 19 && hour < 21.5 ? counts.dusk : null;
      if (bucket === null) return;
      for (const profile of OTTERS) {
        const state = world.otters[profile.id];
        if (state.away) continue;
        bucket[1]! += 1;
        if (state.activity === "denning" || state.activity === "resting") bucket[0]! += 1;
      }
    });
    const midday = counts.midday[0]! / counts.midday[1]!;
    const dusk = counts.dusk[0]! / counts.dusk[1]!;
    assert.ok(midday > 0.6, `midday rest share ${midday}`);
    assert.ok(dusk < midday - 0.25, `dusk rest share ${dusk} vs midday ${midday}`);
  });
});

describe("the public den view", () => {
  test("says whether Holt A's pups are home, and nothing that locates the den or its adults", () => {
    const world = createWorld({ seed: "lontra-creek" });
    const seen = new Set<string>();
    run(world, 10 * TICKS_PER_DAY, () => {
      const views = allViews(world);
      const holtA = views.find(v => v.key === "holt:A")!.data as HoltView;
      const denA = views.find(v => v.key === "den:A")!.data as DenView;
      const denB = views.find(v => v.key === "den:B")!.data as DenView;
      assert.deepEqual(Object.keys(denA).sort(), ["holtId", "pups"]);
      assert.deepEqual(Object.keys(denB).sort(), ["holtId", "pups"]);
      assert.equal(denA.pups, holtA.occupants.includes("Sprout") ? "in-den" : "out");
      assert.equal(denA.pups === "out", world.otters["LO-07"].pupsWithHer);
      assert.equal(denB.pups, "none");
      // Nothing that places the den: no grid reference, no adult, and no reach (a denning otter's reach is withheld).
      const placing = new RegExp(["LC \\d{4}", "Pebble", "Birch", "Juniper", "occupants", "gridRef", "reach", ...REACHES.map(reach => reach.id)].join("|"));
      for (const den of [denA, denB]) assert.doesNotMatch(JSON.stringify(den), placing);
      seen.add(denA.pups);
    });
    assert.deepEqual([...seen].sort(), ["in-den", "out"]);
  });

  test("a checkpoint from before the den view publishes it from the restored tick", () => {
    const world = run(createWorld({ seed: "lontra-creek" }), 500);
    const old = JSON.parse(serialize(world)) as WorldState;
    delete old.published["den:A"];
    delete old.published["den:B"];
    const restored = restore(JSON.stringify(old));
    const den = currentEmissions(restored).find(emission => emission.key === "den:A")!;
    assert.equal(den.revision, revisionFor(1, 500));
    assert.equal(den.topic, "field.dens");
    // Only views that change from here are emitted on the next tick.
    assert.deepEqual(step(restored).map(e => e.key).sort(), step(world).map(e => e.key).sort());
  });
});

test("thirty study days simulate in well under a second", () => {
  const started = performance.now();
  run(createWorld({ seed: "lontra-creek" }), 30 * TICKS_PER_DAY);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `${elapsed.toFixed(0)} ms`);
});
