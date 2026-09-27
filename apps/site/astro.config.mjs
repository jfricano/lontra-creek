import { defineConfig } from "astro/config";

// LONTRA_SITE_PORT and LONTRA_API_PORT (see README.md, Develop) let a whole dev
// stack move to a different port block, so more than one can run at once (F.1).
const SITE_PORT = Number(process.env.LONTRA_SITE_PORT ?? 4321);
const API_PORT = Number(process.env.LONTRA_API_PORT ?? 7402);

export default defineConfig({
  site: "https://streamotter.app",
  server: { host: "127.0.0.1", port: SITE_PORT },
  vite: {
    // In development the field station's small site API runs beside the gateway.
    server: { proxy: { "/api": `http://127.0.0.1:${API_PORT}` } }
  }
  // package.json lists cookie 2 because Astro's prerender output resolves `cookie` from this
  // app, and npm would otherwise hoist the cookie 0.7 that Socket.IO's server (via the gateway) needs.
});
