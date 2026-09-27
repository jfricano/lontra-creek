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
  const headers = { authorization: `Bearer ${process.env[`LAB_BENCH_${number}_SERVICE_TOKEN`]}` };
  assert.equal((await fetch(`http://field-station:7410/lab-internal/${number}/views/station/LC-03`, { headers })).status, 200);
  for (const path of [`/lab-internal/${number % 3 + 1}/views/station/LC-03`, `/lab-internal/${number}/views/holt/A`, '/internal/views/notebook/someone']) {
    assert.equal((await fetch(`http://field-station:7410${path}`, { headers })).status, 401);
  }
  console.log(`Bench ${number}: isolated environment, snapshot scope, and gateway self-checks passed.`);
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
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visitors = [];
  const visitor = address => {
    let cookie = '';
    const client = { async request(path, method = 'GET', body) {
      const response = await fetch(`http://127.0.0.1:7402/api/lab/${path}`, {
        method, headers: { origin: process.env.SITE_ORIGIN, cookie, 'x-client-ip': address, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: response.status, body: await response.json() };
    } };
    visitors.push(client); return client;
  };
  // This test runs on the trusted side of Caddy, inside the field container.
  // Distinct test addresses model distinct visitors without allowing the public
  // proxy to trust attacker-supplied X-Client-IP headers.
  const a = visitor('192.0.2.1'), b = visitor('192.0.2.2'), c = visitor('192.0.2.3'), d = visitor('192.0.2.4');
  const readyDeadline = Date.now() + 90_000;
  while ((await a.request('status')).body.benches.filter(bench => bench.state === 'ready').length !== 3) {
    assert.ok(Date.now() < readyDeadline, 'All three benches must become ready.'); await sleep(1000);
  }
  let heartbeat;
  try {
    const leases = [];
    for (const client of [a, b, c]) {
      const result = await client.request('lease', 'POST', {}); assert.equal(result.status, 200); assert.equal(result.body.status, 'ready'); leases.push(result.body);
      assert.equal((await client.request('lease/token', 'POST', {})).status, 200);
    }
    assert.equal(new Set(leases.map(lease => lease.bench)).size, 3);
    heartbeat = setInterval(() => { for (const client of [a, b, c, d]) void client.request('lease').catch(() => {}); }, 2000);
    const queued = await d.request('lease', 'POST', {}); assert.equal(queued.status, 200); assert.equal(queued.body.status, 'queued'); assert.equal(queued.body.position, 1);
    const one = visitor('192.0.2.9'), two = visitor('192.0.2.9'), three = visitor('192.0.2.9');
    assert.equal((await one.request('lease', 'POST', {})).status, 200); assert.equal((await two.request('lease', 'POST', {})).status, 200);
    const limited = await three.request('lease', 'POST', {}); assert.equal(limited.status, 429); assert.equal(limited.body.code, 'too-many-places');
    for (const client of [one, two]) assert.equal((await client.request('lease/return', 'POST')).body.reason, 'left');
    for (const [path, method, body] of [['lease/token', 'POST', {}], ['actions', 'POST', { action: 'relay.cut' }], ['trace', 'GET', undefined]]) {
      const denied = await one.request(path, method, body); assert.equal(denied.status, 409); assert.equal(denied.body.code, 'no-lease');
    }
    assert.equal((await b.request('lease')).body.leaseId, leases[1].leaseId);
    assert.equal((await a.request('lease/return', 'POST')).body.reason, 'returned');
    const deadline = Date.now() + 60_000;
    let promoted;
    do { promoted = (await d.request('lease')).body; if (promoted.status === 'ready') break; assert.ok(Date.now() < deadline, 'FIFO visitor must get the returned bench after reset.'); await sleep(1000); } while (true);
    assert.equal(promoted.bench, leases[0].bench);
    assert.equal((await d.request('lease/token', 'POST', {})).status, 200);
    console.log('Field station: three concurrent leases, FIFO promotion, address quota, and cross-session isolation passed.');
  } finally {
    clearInterval(heartbeat);
    // Return sequentially: each request retains its own cookie and address.
    for (const client of visitors) await client.request('lease/return', 'POST').catch(() => {});
  }
} else throw new Error('Choose bench or field.');
