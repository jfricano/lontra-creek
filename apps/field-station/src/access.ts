/**
 * Who may read what, shared by the fixture and Kafka handlers. Den sites are for
 * researchers, as real studies restrict them; a notebook is for its owner alone;
 * everything else, including the public den view (pups home or out, no location),
 * is open to any signed-in visitor.
 */
import type { Principal } from "streamotter/contracts";
import { isResearcher } from "./identity.ts";
import type { RecordChannel } from "./records.ts";

export function mayRead(channel: RecordChannel, principal: Principal, params: Readonly<Record<string, unknown>>): boolean {
  if (channel === "holt") return isResearcher(principal);
  if (channel === "notebook") return params["observerId"] === principal.subject;
  return true;
}
