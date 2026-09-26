import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://streamotter.app",
  server: { host: "127.0.0.1", port: 4321 },
  vite: {
    // In development the field station's small site API runs beside the gateway.
    server: { proxy: { "/api": "http://127.0.0.1:7402" } }
  }
  // package.json lists cookie 2 because Astro's prerender output resolves `cookie` from this
  // app, and npm would otherwise hoist the cookie 0.7 that Socket.IO's server (via the gateway) needs.
});
