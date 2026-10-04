/** One isolated bench; see docs/contracts/lab-api.md for its environment boundary. */
import { BenchRuntime } from './runtime.ts';
const runtime = new BenchRuntime(process.env);
const api = runtime.api();
// Listen first, so the bench can explain itself while it boots. A boot that fails
// leaves the bench `failed` for the field station to reset; it never exits, so a
// held source can't put the container in a restart loop (LC11-A33).
await new Promise<void>((resolve, reject) => { api.once('error', reject); api.listen(Number(process.env['BENCH_API_PORT'] ?? 7420), process.env['BENCH_API_HOST'] ?? '0.0.0.0', resolve); });
await runtime.start();
if (runtime.status().state === 'failed') console.error('Check the bench\'s private configuration and broker; the field station will retry its reset.');
let stopping = false;
async function stop() { if (stopping) return; stopping = true; api.close(); api.closeAllConnections(); await runtime.close(); process.exit(0); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
