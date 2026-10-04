import assert from 'node:assert/strict';
const mode = process.argv[2];
const edge = 'https://demo.streamotter.dev';
if (mode === 'attacker') {
  for (const path of ['/api/config', '/streamotter/', '/lab/1/socket.io/?EIO=4&transport=polling']) {
    const response = await fetch(`http://lontra-caddy:8080${path}`, { headers: { origin: 'https://streamotter.dev', 'x-forwarded-for': '10.203.43.2', 'x-client-ip': '10.203.43.2' } });
    assert.equal(response.status, 403, 'Untrusted peer cannot bypass the edge, even with forged headers');
  }
  for (const host of ['field-station', 'gateway', 'kafka', 'lab-1', 'lab-1-kafka']) {
    const { lookup } = await import('node:dns/promises');
    await assert.rejects(lookup(host), `${host} must not be advertised on the edge network`);
  }
  const statuses = await Promise.all(Array.from({length: 45}, async (_, i) => {
    const response = await fetch(`${edge}/api/config`, { headers: { 'x-forwarded-for': `192.0.2.${i + 1}`, 'x-client-ip': `192.0.2.${i + 1}`, 'cf-connecting-ip': `192.0.2.${i + 1}`, 'x-real-ip': `192.0.2.${i + 1}`, forwarded: `for=192.0.2.${i + 1}` } });
    await response.arrayBuffer(); return response.status;
  }));
  assert.ok(statuses.includes(200)); assert.ok(statuses.includes(429), 'Forged forwarding headers must not evade the same visitor budget');
  console.log('Untrusted peer rejected; private services undiscoverable; spoofed headers cannot rotate rate-limit identity.');
} else if (mode === 'other') {
  assert.equal((await fetch(`${edge}/api/config`)).status, 200, 'A different visitor must retain an independent budget');
  for (const path of ['/healthz', '/internal/views/station/LC-03', '/lab/1/bench/v1/status', '/lab/1/management/v1/health', '/management/v1/health']) assert.equal((await fetch(`${edge}${path}`)).status, 404);
  for (const origin of [undefined, 'https://foreign.example']) {
    assert.equal((await fetch(`${edge}/lab/1/socket.io/?EIO=4&transport=websocket`, {headers: origin ? { origin } : {}})).status, 403);
  }
  console.log('Distinct visitor has its own budget; edge preserves private-route and Origin restrictions.');
} else throw new Error('Choose attacker or other.');
