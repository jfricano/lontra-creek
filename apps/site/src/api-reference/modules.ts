/**
 * The import paths the API reference documents, in the order the reference lists them. Each is
 * one of the `streamotter` package's entry points and is also published as its own package.
 * `entry` is the TypeDoc module name: the entry file's base name in streamotter's dist/.
 */
export interface ApiModuleInfo {
  slug: string;
  entry: string;
  importPath: string;
  /** The same entry point in its own scoped package, for apps that install only that package. */
  scopedImport: string;
  title: string;
  description: string;
}

export const API_MODULES: readonly ApiModuleInfo[] = [
  {
    slug: "client", entry: "client", importPath: "streamotter/client", scopedImport: "@streamotter/client", title: "Browser SDK",
    description: "createClient, subscriptions, connection and subscription states, and the errors a browser sees."
  },
  {
    slug: "gateway", entry: "gateway", importPath: "streamotter/gateway", scopedImport: "@streamotter/gateway", title: "Gateway",
    description: "defineProject and createGateway for the Node.js server, with every contract type re-exported for handlers and configuration."
  },
  {
    slug: "contracts", entry: "contracts", importPath: "streamotter/contracts", scopedImport: "@streamotter/contracts", title: "Contracts",
    description: "The shared types and validation the other entry points are built on: configuration, handlers, schemas, limits, errors, and the protocol."
  },
  {
    slug: "operator", entry: "operator", importPath: "streamotter/gateway/operator", scopedImport: "@streamotter/gateway/operator", title: "Operator API",
    description: "Source-failure incidents, quarantine, recovery guards and redrive, in process or over the gateway's local socket. Never exposed to browsers."
  },
  {
    slug: "management", entry: "management", importPath: "streamotter/gateway/management", scopedImport: "@streamotter/gateway/management", title: "Management API",
    description: "The development-only management server and the mountable handler that host the workbench."
  },
  {
    slug: "cli", entry: "cli", importPath: "streamotter/cli", scopedImport: "@streamotter/cli", title: "CLI",
    description: "The streamotter command's programmatic API: running it, generating contract files, and scaffolding a project."
  }
];

export const API_ROOT = "/docs/api/";

export const apiModuleHref = (slug: string) => `${API_ROOT}${slug}/`;
export const apiSymbolHref = (slug: string, name: string) => `${API_ROOT}${slug}/${encodeURIComponent(name)}/`;
