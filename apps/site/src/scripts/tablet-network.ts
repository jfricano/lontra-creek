/**
 * The visitor's "tablet network": lets the demo cut and restore this page's own
 * connection to the gateway, the way walking into a canyon would.
 *
 * It wraps the browser's WebSocket. Cutting closes every open socket and makes new
 * ones fail as they open. Everything that follows is the real StreamOtter SDK
 * reacting to a real closed connection: reconnect attempts, stale views, and, once
 * the network is back, fresh snapshots. Nothing about the gateway or other visitors
 * changes.
 *
 * Base.astro installs the constructor in a classic head script, before bundled
 * modules evaluate. A dynamic SDK import alone is insufficient: production chunk
 * sharing can introduce an eager import before this module runs.
 */
import { bootstrapTabletNetwork } from "./tablet-network-bootstrap.ts";

export function installTabletNetwork(): void {
  bootstrapTabletNetwork();
}

export function isOnline(): boolean {
  return bootstrapTabletNetwork().online;
}

export function setOnline(value: boolean): void {
  bootstrapTabletNetwork().setOnline(value);
}

export function onNetworkChange(listener: (online: boolean) => void): () => void {
  return bootstrapTabletNetwork().onChange(listener);
}
