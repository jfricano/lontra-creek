# Otter game concepts (October 6, 2026)

Three concepts were put to the owner for a React game demonstrating StreamOtter V1.3's hooks. He chose **C, Pup Patrol**; the plan is [README.md](README.md). The other two are kept here in case a second game is ever wanted. All three are read-only on the creek's real channels and make `stale` a game state rather than an error.

## A. Otter Spotter

A top-down map of the seven reaches. Pebble, Birch and Juniper move as the public `otter` channel reports them; the player paddles a canoe (local state) and photographs an otter when in the right reach at the right time. Photos score by what the channel says (species, activity, pups present from the `reach` camera view). Den sites are withheld, as the public channel withholds them, so a visitor learns the audience rule by failing to photograph Pebble at Holt A. Optionally each photo is filed through the existing notebook sighting endpoint, so the album is the visitor's field notebook.

Shows: fog when `otter` is stale, dim gauges when `station` is stale, a signal bar from `useConnectionState`, a snapshot reset on reconnect, a `resync()` button, markers unmounting when an otter leaves the watershed. Needs no new channel, route or simulation change; five to eight subscriptions per visitor.

## B. Creek Keeper

One screen, four gauge stations. Real `station` readings and `creekOverview` weather set the pressure; the player assigns a fixed crew of four to reaches to keep a creek-health meter up through a storm. A stale gauge shows its last reading with its age, and decisions taken on stale data count double. Every crew move re-renders everything while the five subscriptions never resubscribe, which the under-the-hood panel proves with a counter.

Simplest to build and explain; the least otter, and it overlaps the field station page. Needs no new channel or route.

## C. Pup Patrol (chosen)

A sixty-second round herding Sprout and Skipper back to Holt A before the Beaver Flats camera trap fires, driven by the real `reach` frames and a new public den-occupancy view. Most fun to look at; the only concept that needs a new channel view and a simulation change. See the [plan](README.md).

## What each needed

| Change | A | B | C |
| --- | --- | --- | --- |
| Pin `streamotter@1.1.0` from npm | yes | yes | yes |
| React island or app | yes | yes | yes |
| New channel view or simulation change | no | no | yes |
| New backend route | no | no | no |
| Uses the existing notebook sighting write | optional | no | no |
| Subscriptions per visitor | 5 to 8 | 5 | 3 |
| Labeled recording when the demo is down | yes | yes | yes |
| Playwright: load, one round, forced stale state | yes | yes | yes |
