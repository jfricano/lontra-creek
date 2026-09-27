interface ImportMetaEnv {
  /**
   * The field station's origin, such as https://demo.streamotter.app, for the
   * production build. Empty in development, where Vite proxies /api.
   */
  readonly PUBLIC_FIELD_STATION_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*?raw" { const content: string; export default content; }
