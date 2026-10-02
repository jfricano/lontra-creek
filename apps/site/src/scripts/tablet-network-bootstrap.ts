/** Shared with Base.astro's classic head script; keep this function self-contained. */
export interface TabletNetwork {
  readonly online: boolean;
  setOnline(value: boolean): void;
  onChange(listener: (online: boolean) => void): () => void;
}

/**
 * Runs before bundled modules so Socket.IO captures this constructor even when
 * production chunk sharing evaluates the SDK before openFieldClient's import.
 * Base serializes the function into a classic script; it must not capture imports
 * or module variables. Later calls reuse the same per-page controller.
 */
export function bootstrapTabletNetwork(): TabletNetwork {
  const host = window as typeof window & { __lontraTabletNetwork?: TabletNetwork };
  if (host.__lontraTabletNetwork !== undefined) return host.__lontraTabletNetwork;

  let online = true;
  const sockets = new Set<WebSocket>();
  const listeners = new Set<(online: boolean) => void>();
  const Native = window.WebSocket;
  class TabletWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      // Astro's development reload socket must survive the demo's network cut.
      // Otherwise Vite reloads the page and resets the visitor's offline state.
      if (protocols === "vite-hmr" || (Array.isArray(protocols) && protocols.includes("vite-hmr"))) return;
      sockets.add(this);
      this.addEventListener("close", () => sockets.delete(this));
      if (!online) this.close();
    }
  }
  const network: TabletNetwork = {
    get online() { return online; },
    setOnline(value) {
      if (online === value) return;
      online = value;
      if (!value) for (const socket of [...sockets]) socket.close(4000, "Tablet lost signal");
      for (const listener of listeners) listener(value);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  host.__lontraTabletNetwork = network;
  window.WebSocket = TabletWebSocket;
  return network;
}
