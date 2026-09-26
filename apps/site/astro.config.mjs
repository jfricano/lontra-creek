import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://streamotter.app",
  server: { host: "127.0.0.1", port: 4321 },
  vite: {
    // In development the field station's small site API runs beside the gateway.
    server: { proxy: { "/api": "http://127.0.0.1:7402" } }
  }
});
