interface ImportMetaEnv {
  /**
   * The field station's origin, such as https://demo.streamotter.dev, for the
   * production build. Empty in development, where Vite proxies /api.
   */
  readonly PUBLIC_FIELD_STATION_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*?raw" { const content: string; export default content; }

/** The installed workbench's WHC-1 manifest, or null when the site pins none (integrations/workbench-assets.mjs). */
declare module "virtual:lontra/workbench-host" {
  const manifest: import("streamotter/contracts").WorkbenchHostManifest | null;
  export default manifest;
}
