/** One isolated bench; see docs/contracts/lab-api.md for its environment boundary. */
import { BenchRuntime } from './runtime.ts';
const runtime = new BenchRuntime(process.env);
const api = runtime.api();
try { await runtime.start(); } catch { console.error('Bench startup failed. Check its private configuration and broker.'); await runtime.close(); process.exit(1); }
await new Promise<void>((resolve, reject) => { api.once('error', reject); api.listen(Number(process.env['BENCH_API_PORT'] ?? 7420), process.env['BENCH_API_HOST'] ?? '0.0.0.0', resolve); });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; api.close(); api.closeAllConnections(); await runtime.close(); process.exit(0); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
