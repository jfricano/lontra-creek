/** The workbench sandbox service; see docs/contracts/sandbox-api.md and LC11-ADR-04 for its boundary. */
import { publishedBackend, SandboxService, sandboxEnvironment } from './service.ts';
const settings = sandboxEnvironment(process.env);
// The published backend is the only one: test fixtures are never selectable here.
const service = new SandboxService({ backend: publishedBackend(), slots: settings.slots, serviceToken: settings.serviceToken });
const api = service.api();
await service.start();
await new Promise<void>((resolve, reject) => { api.once('error', reject); api.listen(settings.port, settings.host, resolve); });
const timer = setInterval(() => service.sweep(), 1000);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; clearInterval(timer); api.close(); api.closeAllConnections(); await service.close(); process.exit(0); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
