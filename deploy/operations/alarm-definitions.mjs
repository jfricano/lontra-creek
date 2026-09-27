#!/usr/bin/env node
// Produces reviewable OCI CreateAlarm JSON only. Never calls a cloud API.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [compartment, instance, topic, directory] = process.argv.slice(2);
if (![compartment, instance, topic].every(value => /^ocid1\.[a-z]+\.[a-z0-9.]+$/.test(value ?? '')) || !directory) {
  console.error('Usage: alarm-definitions.mjs compartment-ocid instance-ocid notification-topic-ocid output-dir');
  process.exit(2);
}
mkdirSync(directory, { recursive: true });
const common = {
  compartmentId: compartment, metricCompartmentId: compartment,
  destinations: [topic], isEnabled: false, severity: 'CRITICAL',
  pendingDuration: 'PT15M', repeatNotificationDuration: 'PT1H',
};
const definitions = [
  ['memory-low', 'oci_computeagent', `MemoryUtilization[5m]{resourceId="${instance}"}.mean() < 25`,
    'Investigate memory below the planned threshold; confirm actual monitoring and account policy.'],
  ['instance-unavailable', 'oci_compute_infrastructure_health', `instance_status[1m]{resourceId="${instance}"}.max() > 0`,
    'OCI reports infrastructure unavailability. Check host and public demo health.'],
  ['instance-telemetry-absent', 'oci_compute_infrastructure_health', `instance_status[1m]{resourceId="${instance}"}.absent()`,
    'Instance telemetry absent: the VM may be stopped, deleted, or monitoring delayed. Investigate.'],
];
for (const [name, namespace, query, body] of definitions) {
  writeFileSync(join(directory, `${name}.json`), JSON.stringify({
    ...common, displayName: `lontra-${name}`, namespace, query, body,
  }, null, 2) + '\n', { flag: 'wx' });
}
console.log('Wrote three disabled alarm definitions. Review limits, IAM, destinations and queries before applying.');
