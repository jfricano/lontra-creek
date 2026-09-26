/**
 * Compile-time proof that the simulation's views are exactly the payloads the
 * generated channel types expect, in both directions. `npm run typecheck` fails if
 * the simulation and the schemas in project.ts drift apart. Notebooks are the one
 * channel the simulation doesn't publish.
 */
import type { ChannelParams, ChannelViews } from "@lontra-creek/sim";
import type { AppChannels } from "./generated/streamotter.generated.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

export type ChannelContractsMatch = [
  Expect<Same<Exclude<keyof AppChannels, "notebook">, keyof ChannelViews>>,
  Expect<Same<AppChannels["creekOverview"]["data"], ChannelViews["creekOverview"]>>,
  Expect<Same<AppChannels["station"]["data"], ChannelViews["station"]>>,
  Expect<Same<AppChannels["otter"]["data"], ChannelViews["otter"]>>,
  Expect<Same<AppChannels["reach"]["data"], ChannelViews["reach"]>>,
  Expect<Same<AppChannels["holt"]["data"], ChannelViews["holt"]>>,
  Expect<Same<AppChannels["creekOverview"]["params"], ChannelParams["creekOverview"]>>,
  Expect<Same<AppChannels["station"]["params"], ChannelParams["station"]>>,
  Expect<Same<AppChannels["otter"]["params"], ChannelParams["otter"]>>,
  Expect<Same<AppChannels["reach"]["params"], ChannelParams["reach"]>>,
  Expect<Same<AppChannels["holt"]["params"], ChannelParams["holt"]>>
];
