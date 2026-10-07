/** Display names for the reference's kinds of declaration, and the order export lists group them in. */
import type { ApiKind } from "./build.ts";

export const KIND_LABELS: Readonly<Record<ApiKind, string>> = {
  function: "Function", class: "Class", variable: "Constant", interface: "Interface", type: "Type alias", enum: "Enum", namespace: "Namespace"
};

export const KIND_GROUPS: readonly { label: string; kinds: readonly ApiKind[] }[] = [
  { label: "Functions", kinds: ["function"] },
  { label: "Classes", kinds: ["class"] },
  { label: "Constants", kinds: ["variable", "enum"] },
  { label: "Interfaces", kinds: ["interface"] },
  { label: "Type aliases", kinds: ["type"] },
  { label: "Namespaces", kinds: ["namespace"] }
];
