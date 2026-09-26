/**
 * Who may read what, shared by the fixture and Kafka handlers. Den sites are for
 * researchers, as real studies restrict them; everything else is open to any
 * signed-in visitor.
 */
import type { ChannelName } from "@lontra-creek/sim";
import type { Principal } from "streamotter/contracts";
import { isResearcher } from "./identity.ts";

export function mayRead(channel: ChannelName, principal: Principal): boolean {
  return channel !== "holt" || isResearcher(principal);
}
