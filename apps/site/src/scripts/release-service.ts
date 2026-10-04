/**
 * `/releases/`: what the running field station says about itself, read when the page
 * loads. The static facts on the page describe this build; this block reports what the
 * service actually answers (`GET /api/config` and `GET /api/lab/capabilities`) and says
 * so plainly when it doesn't answer. Nothing is filled in from the build when the service
 * is silent.
 */
import type { LabCapabilities } from "../../../field-station/src/lab/contract.ts";
import { SCENARIOS, TRACKS } from "../lab-catalog.ts";
import { fetchConfig, type FieldConfig } from "./field-api.ts";
import { capabilityAnswer, scenarioAvailability, type CapabilityAnswer } from "./lab-catalog-model.ts";

/** The source-failure stories the current bench can't run, from the Lab catalog (as on the page above). */
const WAITING_EXERCISES = TRACKS["source-failures"].filter(id => SCENARIOS[id].controls === null);

/** What the service answered. `config` is null when `/api/config` failed. */
export interface ServiceAnswer {
  config: FieldConfig | null;
  capabilities: CapabilityAnswer;
}

/** The report's lines, in reading order. `builtWith` is the StreamOtter version this page was built against. */
export function serviceLines(answer: ServiceAnswer, builtWith: string): string[] {
  const { config, capabilities } = answer;
  if (config === null && capabilities.kind !== "summary") return ["The field station didn't answer, so this page can't say what the demo runs right now. The facts above still describe this build."];
  const lines: string[] = [];
  if (config === null) lines.push("Field station: its configuration didn't answer.");
  else lines.push(config.mode === "fixture" ? "Field station: answering, replaying fixture data without Kafka." : "Field station: answering, on real Kafka with synthetic data.");
  switch (capabilities.kind) {
    case "summary": {
      const { summary } = capabilities;
      lines.push(`StreamOtter it runs: ${summary.library.version}.${summary.library.version === builtWith ? "" : ` This page was built for ${builtWith}, so some facts above may not match it.`}`);
      lines.push(summary.backend.lab === "enabled" ? "Lab benches: enabled." : "Lab benches: none on this backend.");
      lines.push(`New source-failure exercises it can run: ${runnable(summary)} of ${WAITING_EXERCISES.length}.`);
      break;
    }
    case "absent": lines.push("It doesn't report Lab capabilities, so the StreamOtter version it runs and the exercises it can run are unknown here."); break;
    case "unreachable": lines.push("Its Lab capability check didn't answer, so the StreamOtter version it runs and the exercises it can run are unknown here."); break;
    case "pending": break;
  }
  return lines;
}

function runnable(summary: LabCapabilities): number {
  return WAITING_EXERCISES.filter(id => scenarioAvailability(id, { kind: "summary", summary }).state === "available").length;
}

async function readCapabilities(origin: string): Promise<CapabilityAnswer> {
  try {
    const response = await fetch(`${origin}/api/lab/capabilities`, { cache: "no-store", credentials: "include", signal: AbortSignal.timeout(8_000) });
    if (response.status === 404) return { kind: "absent" };
    if (!response.ok) return { kind: "unreachable" };
    return capabilityAnswer(await response.json().catch(() => null));
  } catch {
    return { kind: "unreachable" };
  }
}

export async function mountReleaseService(root: HTMLElement, builtWith: string): Promise<void> {
  const status = root.querySelector<HTMLElement>("[data-release-service-status]");
  const list = root.querySelector<HTMLElement>("[data-release-service-lines]");
  if (!status || !list) return;
  const origin = (import.meta.env?.PUBLIC_FIELD_STATION_ORIGIN ?? "").replace(/\/+$/, "");
  const [config, capabilities] = await Promise.all([
    fetchConfig(AbortSignal.timeout(8_000)).catch(() => null),
    readCapabilities(origin)
  ]);
  const lines = serviceLines({ config, capabilities }, builtWith);
  list.replaceChildren(...lines.map(line => Object.assign(document.createElement("li"), { textContent: line })));
  const answered = config !== null || capabilities.kind === "summary";
  root.dataset["service"] = answered ? "answered" : "unreachable";
  status.textContent = answered ? "The field station answered." : "The field station didn't answer.";
}
