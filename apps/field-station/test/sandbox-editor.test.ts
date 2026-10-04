/**
 * Restricted candidate editor (sandbox contract §5) and operation allowlist (§6).
 * Evidence level: fixture (unit), with the published validator from
 * streamotter@0.1.0-rc.3. LC11-A43 restricted editor and private management boundary.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProjectConfig, type ProjectConfig } from 'streamotter/contracts';
import { reviewCandidate, validateCandidate } from '../src/sandbox/editor.ts';
import { checkInput, inputFromRequest, operationRoute, routeOperation, SANDBOX_OPERATIONS, SandboxFault } from '../src/sandbox/operations.ts';
import { fixtureBase } from './support/sandbox-fixture.ts';
import { code, harness, wb } from './support/sandbox-harness.ts';

const maxima = { receiptTimeoutMs: 10_000, maxSubscriptionsPerConnection: 8, maxPendingFramesPerSubscription: 100 };
type Mutable = Record<string, any>;
const edit = (change: (c: Mutable) => void): Mutable => { const c = structuredClone(fixtureBase(1)) as Mutable; change(c); return c; };
const refused = (c: unknown) => reviewCandidate(fixtureBase(1), c, maxima);

test('A43: allowlisted edits (schemas, channel versions, three limits) pass and are validated by the published validator', () => {
  const candidate = edit(c => {
    c.schemas.station.properties.stage.maximum = 12; c.schemas.jobProgress.properties.note = { type: 'string', maxLength: 80 };
    c.channels.jobProgress.version = 2; c.limits.receiptTimeoutMs = 8000; c.limits.maxPendingFramesPerSubscription = 50; c.limits.maxSubscriptionsPerConnection = 6;
  });
  assert.equal(refused(candidate), null);
  const result = validateCandidate(fixtureBase(1), candidate, maxima);
  assert.deepEqual({ valid: result.valid, issues: result.issues }, validateProjectConfig(candidate));
  assert.equal(result.valid, true);
  const broken = edit(c => { c.schemas.station.type = 'banana'; });
  assert.equal(refused(broken), null, 'a schema may change');
  const invalid = validateCandidate(fixtureBase(1), broken, maxima);
  assert.equal(invalid.valid, false); assert.equal(invalid.refused, false); assert.ok(invalid.issues.some(i => i.path.startsWith('/schemas/station')), 'the published validator judges the schema');
});

test('A43: every server-owned or unlisted change is refused with the first offending JSON pointer', () => {
  const cases: [(c: Mutable) => void, string][] = [
    [c => { c.sources.creek.fixtureRef = '/etc/passwd'; }, '/sources/creek/fixtureRef'],
    [c => { c.sources.evil = { kind: 'kafka', generation: 'x', connectionRef: 'prod', topics: ['field.gauges'], consumerGroup: 'g', codec: 'json', startFrom: 'earliest' }; }, '/sources/evil'],
    [c => { c.connections.prod = { brokers: ['kafka:9093'], tls: false }; }, '/connections/prod'],
    [c => { c.channels.station.source = 'jobs'; }, '/channels/station/source'],
    [c => { c.channels.station.handlersRef = 'jobProgress'; }, '/channels/station/handlersRef'],
    [c => { c.channels.station.paramsSchema = 'jobParams'; }, '/channels/station/paramsSchema'],
    [c => { c.channels.station.delivery.overflow = 'drop'; }, '/channels/station/delivery/overflow'],
    [c => { delete c.channels.jobProgress; }, '/channels/jobProgress'],
    [c => { c.channels.extra = structuredClone(c.channels.station); }, '/channels/extra'],
    [c => { c.schemas['a/b~c'] = { type: 'null' }; }, '/schemas/a~1b~0c'],
    [c => { delete c.schemas.jobParams; }, '/schemas/jobParams'],
    [c => { c.gateway.allowedOrigins[0] = 'https://evil.test'; }, '/gateway/allowedOrigins/0'],
    [c => { c.gateway.allowedOrigins.push('https://evil.test'); }, '/gateway/allowedOrigins/1'],
    [c => { c.gateway.port = 80; }, '/gateway/port'],
    [c => { c.projectId = 'production'; }, '/projectId'],
    [c => { c.configVersion = 2; }, '/configVersion'],
    [c => { c.limits.maxConnections = 1000; }, '/limits/maxConnections'],
    [c => { c.handlers = './evil.js'; }, '/handlers'],
    // Two violations: the first in the base's key order wins.
    [c => { c.limits.maxConnections = 9; c.projectId = 'x'; }, '/projectId']
  ];
  for (const [change, pointer] of cases) {
    const issue = refused(edit(change));
    assert.equal(issue?.code, 'FIELD_NOT_EDITABLE', pointer); assert.equal(issue?.path, pointer);
  }
  assert.equal(refused([1, 2])?.path, '', 'a non-object candidate is refused as a whole');
});

test('A43: editable fields keep their bounds, including a removed limit that would fall back above the slot maximum', () => {
  const cases: [(c: Mutable) => void, string][] = [
    [c => { c.channels.station.version = 100; }, '/channels/station/version'],
    [c => { c.channels.station.version = 1.5; }, '/channels/station/version'],
    [c => { c.limits.maxSubscriptionsPerConnection = 9; }, '/limits/maxSubscriptionsPerConnection'],
    [c => { c.limits.receiptTimeoutMs = 0; }, '/limits/receiptTimeoutMs'],
    [c => { delete c.limits.maxSubscriptionsPerConnection; }, '/limits/maxSubscriptionsPerConnection']
  ];
  for (const [change, pointer] of cases) { const issue = refused(edit(change)); assert.equal(issue?.code, 'VALUE_OUT_OF_BOUNDS', pointer); assert.equal(issue?.path, pointer); }
  assert.equal(refused(edit(c => { delete c.channels.station.version; }))?.code, 'FIELD_NOT_EDITABLE');
  assert.equal(refused(edit(c => { delete c.limits; }))?.path, '/limits/maxConnections', 'removing every limit removes a server-owned one first');
  const big = edit(c => { c.schemas.station.properties.stage.description = 'x'.repeat(70_000); });
  assert.throws(() => validateCandidate(fixtureBase(1), big, maxima), (e: unknown) => e instanceof SandboxFault && e.code === 'candidate-too-large' && e.wbStatus === 413);
});

test('A43: the operation allowlist is closed, follows WHC-1 names, and bounds every input', () => {
  assert.deepEqual([...SANDBOX_OPERATIONS].sort(), ['capabilities', 'channels', 'config', 'config.export', 'config.validate', 'dev.disconnect', 'dev.fixtures.advance', 'dev.principals', 'health', 'preview-sessions', 'source-checks', 'sources', 'sources.resume', 'traces']);
  for (const [method, path, op] of [['GET', '/failures', 'failures.list'], ['GET', '/failures/f-1', 'failures.show'], ['POST', '/failures/redrive', 'failures.redrive'], ['GET', '/operator/status', 'operator.status'], ['POST', '/sources/reopen-circuit', 'sources.reopen-circuit']] as const) {
    assert.equal(routeOperation(method, path), op); assert.ok(!SANDBOX_OPERATIONS.includes(op as never), `${op} is not served`);
  }
  for (const [method, path] of [['POST', '/sources/retire-boundary'], ['GET', '/management/v1/health'], ['DELETE', '/config'], ['GET', '/config/validate'], ['GET', '/../health']] as const) assert.equal(routeOperation(method, path), null);
  const bad = (op: Parameters<typeof checkInput>[0], input: unknown) => assert.throws(() => checkInput(op, input), (e: unknown) => e instanceof SandboxFault && e.code === 'invalid-request', `${op} ${JSON.stringify(input)}`);
  bad('dev.fixtures.advance', { sourceId: 'creek', count: 11 }); bad('dev.fixtures.advance', { sourceId: 'creek', count: 0 }); bad('dev.fixtures.advance', { sourceId: 'creek' });
  bad('source-checks', { sourceId: 'creek', brokers: ['evil:9092'] }); bad('source-checks', { sourceId: '../../etc' }); bad('health', { anything: 1 });
  bad('preview-sessions', { fixturePrincipalRef: 'x'.repeat(65) }); bad('config.validate', { config: 'text' }); bad('traces', { limit: 501 }); bad('traces', { limit: 0 }); bad('traces', { offset: 0 });
  assert.throws(() => inputFromRequest('health', new URLSearchParams('x=1'), undefined), (e: unknown) => e instanceof SandboxFault);
  assert.throws(() => inputFromRequest('traces', new URLSearchParams('limit=5&limit=6'), undefined), (e: unknown) => e instanceof SandboxFault);
  assert.deepEqual(inputFromRequest('traces', new URLSearchParams('limit=5&outcome=failed'), undefined), { limit: 5, outcome: 'failed' });
  assert.deepEqual(inputFromRequest('traces', new URLSearchParams('limit=500'), undefined), { limit: 500 }, 'the workbench asks for up to 500 traces');
  for (const op of SANDBOX_OPERATIONS) { const { method, path } = operationRoute(op); assert.equal(routeOperation(method, path), op, 'each operation maps back to its own route'); }
});

test('A43: the service applies the editor before validating, never applies a candidate, and scopes sources, principals, and previews to the slot', async () => {
  const h = await harness({ slots: 1 }); const s = h.session('s'); await h.join(s); await h.claim(s);
  const runtime = h.fixture.current(1);
  const refusedValidate = await h.opSlow(s, 'config.validate', { config: edit(c => { c.sources.creek.fixtureRef = 'other'; }) }) as { valid: boolean; issues: { path: string; code: string }[] };
  assert.deepEqual(refusedValidate, { valid: false, issues: [{ path: '/sources/creek/fixtureRef', code: 'FIELD_NOT_EDITABLE', message: '/sources/creek/fixtureRef is server-owned in the sandbox.' }] });
  assert.equal((await h.opSlow(s, 'config.validate', { config: edit(c => { c.channels.station.version = 3; }) }) as { valid: boolean }).valid, true);
  await assert.rejects(h.opSlow(s, 'config.export', { config: edit(c => { c.connections.x = { brokers: ['a:1'], tls: false }; }) }), wb('CONFIG_INVALID', 'field-not-editable'));
  await assert.rejects(h.opSlow(s, 'config.export', { config: edit(c => { c.schemas.station.type = 'banana'; }) }), wb('CONFIG_INVALID', 'invalid-request'));
  assert.ok(!runtime.calls.some(c => c.op === 'config.validate'), 'validation runs in the service with the published validator');
  assert.equal(runtime.calls.filter(c => c.op === 'config.export').length, 0, 'nothing refused reaches the runtime');
  const config = await h.opSlow(s, 'config') as { config: ProjectConfig }; assert.deepEqual(config.config, fixtureBase(1), 'the running project is unchanged');

  await assert.rejects(h.opSlow(s, 'source-checks', { sourceId: 'production' }), wb('INVALID_REQUEST'));
  for (const sourceId of ['constructor', 'toString', '__proto__']) {
    await assert.rejects(h.opSlow(s, 'source-checks', { sourceId }), wb('INVALID_REQUEST'), `${sourceId} is not one of the slot's sources`);
    await assert.rejects(h.opSlow(s, 'traces', { sourceId }), wb('INVALID_REQUEST'));
    await assert.rejects(h.opSlow(s, 'sources.resume', { sourceId }), wb('INVALID_REQUEST'));
  }
  assert.ok(!runtime.calls.some(c => c.op === 'source-checks' || c.op === 'traces' || c.op === 'sources.resume'), 'no refused source reaches the runtime');
  await assert.rejects(h.opSlow(s, 'dev.fixtures.advance', { sourceId: 'nope', count: 1 }), wb('INVALID_REQUEST'));
  await assert.rejects(h.opSlow(s, 'traces', { channel: 'holt' }), wb('INVALID_REQUEST'));
  await assert.rejects(h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'operator-only' }), wb('INVALID_REQUEST'));
  assert.deepEqual((await h.opSlow(s, 'dev.principals') as { items: { ref: string }[] }).items.map(i => i.ref), ['creek-volunteer', 'developer'], 'only the slot\'s synthetic principals are listed');
  const preview = await h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'creek-volunteer' }) as { expiresAt: string };
  assert.ok(Date.parse(preview.expiresAt) <= Date.parse((h.view(s) as { expiresAt: string }).expiresAt));
  await assert.rejects(h.opSlow(s, 'failures.list' as never), wb('FORBIDDEN', 'operation-not-allowed'));
});

test('A43: an export refused for many issues keeps details.code and a bounded, flagged issues list', async () => {
  const h = await harness({ slots: 1 }); const s = h.session('s'); await h.join(s); await h.claim(s);
  const candidate = edit(c => { const properties: Mutable = {}; for (let i = 0; i < 400; i++) properties[`p${i}`] = { type: 'bogus' }; c.schemas.station = { type: 'object', properties }; });
  const all = await h.opSlow(s, 'config.validate', { config: candidate }) as { valid: boolean; issues: unknown[] };
  assert.equal(all.valid, false); assert.ok(JSON.stringify(all.issues).length > 16_384, 'more issues than fit in 16 KB');
  const error = await h.opSlow(s, 'config.export', { config: candidate }).then(() => assert.fail('exported'), (e: { status: number; error: { code: string; details?: { code?: string; issues?: unknown[]; issuesTruncated?: boolean } } }) => e);
  assert.equal(error.status, 400); assert.equal(error.error.code, 'CONFIG_INVALID');
  const details = error.error.details!; assert.equal(details.code, 'invalid-request', 'refused and invalid stay distinguishable');
  assert.ok(details.issues!.length > 0 && details.issues!.length < all.issues.length); assert.deepEqual(details.issues, all.issues.slice(0, details.issues!.length));
  assert.equal(details.issuesTruncated, true); assert.ok(JSON.stringify(details).length <= 16_384);
});

test('A43: an operation the installed release does not support is left out of discovery and refused', async () => {
  const h = await harness({ slots: 1 }); h.fixture.operations = ['capabilities', 'health', 'config', 'config.validate']; await h.advance(5000);
  assert.deepEqual(h.pool.discovery(), { hostContract: 1, operations: ['workbench', 'capabilities', 'health', 'config', 'config.validate'], limits: { maxRequestBytes: 65_536 } });
  const s = h.session('s'); await h.join(s); await h.claim(s);
  await assert.rejects(h.opSlow(s, 'traces', {}), wb('FORBIDDEN', 'operation-not-allowed'));
  // The refused operation still spent one of the session's eight.
  for (let i = 0; i < 7; i++) await h.op(s, 'health');
  await assert.rejects(h.op(s, 'health'), code('too-many-requests'));
});
