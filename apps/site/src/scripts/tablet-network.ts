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
 * Install it before the SDK loads: Socket.IO captures the WebSocket constructor
 * when its module is first evaluated.
 */
type Listener = (online: boolean) => void;

let installed = false;
let online = true;
const sockets = new Set<WebSocket>();
const listeners = new Set<Listener>();

export function installTabletNetwork(): void {
  if (installed) return;
  installed = true;
  const Native = window.WebSocket;
  class TabletWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.add(this);
      this.addEventListener("close", () => sockets.delete(this));
      // No signal: the attempt fails, as it would out of range of a tower.
      if (!online) this.close();
    }
  }
  window.WebSocket = TabletWebSocket;
}

export function isOnline(): boolean {
  return online;
}

export function setOnline(value: boolean): void {
  if (online === value) return;
  online = value;
  if (!value) {
    for (const socket of [...sockets]) socket.close(4000, "Tablet lost signal");
  }
  for (const listener of listeners) listener(value);
}

export function onNetworkChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
