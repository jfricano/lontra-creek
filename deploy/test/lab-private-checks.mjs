/** Run via `docker compose exec -T <service> node --input-type=module - <role> < file`. */
import assert from 'node:assert/strict';
const role = process.argv[2];
if (role === 'bench') {
  const number = Number(process.env.LAB_BENCH);
  assert.ok([1, 2, 3].includes(number));
  for (const key of Object.keys(process.env)) {
    assert.ok(!key.startsWith('FIELD_STATION_'), `Forbidden environment key: ${key}`);
    assert.ok(!['KAFKA_GATEWAY_PASSWORD', 'KAFKA_FIELD_STATION_PASSWORD'].includes(key), `Forbidden environment key: ${key}`);
    if (/^LAB_BENCH_[123]_(SERVICE|RELAY)_TOKEN$/.test(key)) assert.ok(key.startsWith(`LAB_BENCH_${number}_`), `Other-bench credential: ${key}`);
  }
  const response = await fetch('http://127.0.0.1:7420/bench/v1/status', {
    headers: { authorization: `Bearer ${process.env[`LAB_BENCH_${number}_SERVICE_TOKEN`]}` }
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(status.checks, { developmentPrincipals: 0, fixtureSources: 0, managementHost: '127.0.0.1' });
  assert.equal(status.bench, number);
  console.log(`Bench ${number}: isolated environment and gateway self-checks passed.`);
} else if (role === 'field') {
  for (let number = 1; number <= 3; number++) {
    let reachable = false;
    try { await fetch(`http://lab-${number}:7401/management/v1/health`, { signal: AbortSignal.timeout(2000) }); reachable = true; } catch { /* loopback-only management must be unreachable */ }
    assert.equal(reachable, false, `Bench ${number} management must not be reachable over the Compose network.`);
    assert.equal(process.env[`LAB_BENCH_${number}_RELAY_TOKEN`], undefined, 'The field station must not hold relay-control credentials.');
    const other = number % 3 + 1;
    const response = await fetch(`http://lab-${number}:7420/bench/v1/status`, {
      headers: { authorization: `Bearer ${process.env[`LAB_BENCH_${other}_SERVICE_TOKEN`]}` }
    });
    assert.equal(response.status, 401, 'Another bench service credential must be refused.');
  }
  console.log('Field station: management network isolation and per-bench API authentication passed.');
} else throw new Error('Choose bench or field.');
