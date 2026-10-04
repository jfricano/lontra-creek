/**
 * The playground's examples (LC11-A34): the `streamotter init` example, failure-policy
 * presets, and configurations the validator refuses. The page loads one into the editor and
 * shows what the installed validator says about it, in the browser; nothing here states
 * the expected result, so the page never repeats the validator's rules.
 * test/playground-presets.test.ts holds each preset to the result its note describes.
 *
 * Every preset is configuration only. No handler runs, nothing connects to Kafka, and the
 * hosted field station never sees an edit.
 */
import base from "./playground-config.json" with { type: "json" };

export interface PlaygroundPreset {
  id: string;
  label: string;
  /** Whether the note describes a configuration the validator accepts. Shown only as the group the preset is listed in. */
  group: "accepted" | "refused";
  /** What the example shows, and what validation can't check. */
  note: string;
  config: Readonly<Record<string, unknown>>;
}

/** The init example's jobs source, read from Kafka instead of the fixture: quarantine policies on Kafka need a quarantine topic. */
const kafka = {
  ...base,
  connections: { local: { brokers: ["127.0.0.1:9092"], tls: false } },
  sources: {
    jobs: { kind: "kafka", connectionRef: "local", topics: ["jobs.progress"], consumerGroup: "my-first-stream-jobs", generation: "jobs-1", codec: "json", startFrom: "earliest" }
  }
};
const quarantine = { topic: "jobs.streamotter.quarantine", capture: "full-record" };

export const PLAYGROUND_PRESETS: readonly PlaygroundPreset[] = [
  {
    id: "init-example",
    label: "The init example, no failure policy",
    group: "accepted",
    note: "An example project like the one streamotter init scaffolds. Without a failureHandling section, a bad record pauses its source, as in earlier releases.",
    config: base
  },
  {
    id: "quarantine-hold",
    label: "quarantine-hold on a Kafka source",
    group: "accepted",
    note: "Invalid JSON and payload-schema failures are copied to the quarantine topic, and the source stays held at the record. Validation can't check that the topic exists, is large enough, or that the gateway may write to it; the gateway checks the topic at startup.",
    config: { ...kafka, failureHandling: { quarantine, sources: { jobs: { invalidJson: "quarantine-hold", invalidPublicPayload: "quarantine-hold" } } } }
  },
  {
    id: "quarantine-resync",
    label: "quarantine-resync, which needs a recovery guard",
    group: "accepted",
    note: "Valid configuration, but not a complete setup. The validator can't see handlers: the gateway refuses to start this without a recovery guard at handlers.sources.jobs.recover, and only your application can make that guard's answer true.",
    config: { ...kafka, failureHandling: { quarantine, sources: { jobs: { invalidJson: "quarantine-resync", invalidPublicPayload: "quarantine-hold", automaticAdvanceLimit: { incidents: 5, windowMs: 60_000 } } } } }
  },
  {
    id: "bounded-retry",
    label: "Bounded retry of a transient mapper failure",
    group: "accepted",
    note: "Up to two more attempts after the map handler throws a TransientMappingError, then pause. replaySafeMapping is your declaration that the map handler is safe to repeat; StreamOtter can't check it.",
    config: { ...base, failureHandling: { sources: { jobs: { transientMapperRetries: 2, replaySafeMapping: true } } } }
  },
  {
    id: "skip-policies",
    label: "ignore and force-skip",
    group: "refused",
    note: "There is no policy that skips a record silently.",
    config: { ...kafka, failureHandling: { quarantine, sources: { jobs: { invalidJson: "ignore", invalidPublicPayload: "force-skip" } } } }
  },
  {
    id: "topic-overlap",
    label: "A quarantine topic the source also reads",
    group: "refused",
    note: "Quarantined records must not land on a topic a source consumes.",
    config: { ...kafka, failureHandling: { quarantine: { ...quarantine, topic: "jobs.progress" }, sources: { jobs: { invalidJson: "quarantine-hold" } } } }
  },
  {
    id: "missing-quarantine",
    label: "A quarantine policy with no quarantine topic",
    group: "refused",
    note: "A Kafka source with a quarantine policy needs failureHandling.quarantine.",
    config: { ...kafka, failureHandling: { sources: { jobs: { invalidJson: "quarantine-hold" } } } }
  },
  {
    id: "retry-not-replay-safe",
    label: "Retries without replaySafeMapping",
    group: "refused",
    note: "Retries repeat the map handler, so they need your declaration that it is safe to repeat.",
    config: { ...base, failureHandling: { sources: { jobs: { transientMapperRetries: 2 } } } }
  }
];

/** The editor's text for a preset, as the page shows it. */
export function presetText(preset: PlaygroundPreset): string {
  return JSON.stringify(preset.config, null, 2);
}
