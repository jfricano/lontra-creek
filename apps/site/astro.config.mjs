import { defineConfig } from "astro/config";
import workbenchAssets from "./integrations/workbench-assets.mjs";

// LONTRA_SITE_PORT and LONTRA_API_PORT (see README.md, Develop) let a whole dev
// stack move to a different port block, so more than one can run at once (F.1).
//
// Number("") is 0, not the default, so an empty or unset variable must be
// told apart from a bad one instead of silently binding to port 0.
function parsePort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer port number; got ${JSON.stringify(raw)}.`);
  }
  return value;
}

const SITE_PORT = parsePort("LONTRA_SITE_PORT", 4321);
const API_PORT = parsePort("LONTRA_API_PORT", 7402);

export default defineConfig({
  site: "https://streamotter.dev",
  server: { host: "127.0.0.1", port: SITE_PORT },
  // Serves the pinned published workbench at /workbench/assets/<version>/ (sandbox contract §4).
  integrations: [workbenchAssets()],
  // /workbench/'s policy allows only 'self' scripts, styles and fonts, so no page's CSS,
  // bundled script, or font is inlined (Astro inlines small scripts under Vite's
  // assetsInlineLimit, and Vite small fonts as data: URLs; other assets keep the default).
  build: { inlineStylesheets: "never" },
  vite: {
    build: { assetsInlineLimit: file => (/\.(?:js|woff2?)$/.test(file) ? false : undefined) },
    // In development the field station's small site API runs beside the gateway.
    server: { proxy: { "/api": `http://127.0.0.1:${API_PORT}` } }
  }
  // package.json lists cookie 2 because Astro's prerender output resolves `cookie` from this
  // app, and npm would otherwise hoist the cookie 0.7 that Socket.IO's server (via the gateway) needs.
});
