/** Runs against the real Kafka Lab API. Set LAB_API_ORIGIN and LAB_SITE_ORIGIN. */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createClient } from 'streamotter/client';
import type { Client, SubscriptionState } from 'streamotter/client';
import http from 'node:http';
import https from 'node:https';
import type { LabAction, LabActionResult, LabFeedPage, LabLease, LabToken } from '../../apps/field-station/src/lab/contract.ts';
import type { LabChannels } from '../../apps/field-station/src/lab/bench.ts';
const API = process.env['LAB_API_ORIGIN'];
const SITE = process.env['LAB_SITE_ORIGIN'] ?? 'https://streamotter.app';
// The Node SDK transport does not send a browser Origin automatically.
for (const transport of [http, https]) {
  const original = transport.request;
  transport.request = ((...args: unknown[]) => {
    const options = args[0];
    if (typeof options === 'object' && options !== null && !(options instanceof URL)) {
      const headers = (options as http.RequestOptions).headers as Record<string, unknown> | undefined;
      if (headers?.['Upgrade'] === 'websocket') headers['Origin'] = SITE;
    }
    return (original as (...values: unknown[]) => ReturnType<typeof http.request>)(...args);
  }) as typeof transport.request;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 35_000) { const deadline=Date.now()+timeout; while(!await check()){ if(Date.now()>deadline)throw new Error(`Timed out: ${label}`); await sleep(1000); } }
let cookie=''; let client: Client<LabChannels> | undefined;
async function api<T>(path: string, method='GET', body?: unknown, session=cookie): Promise<T> { const response=await fetch(`${API}/api/lab/${path}`, {method,headers:{origin:SITE,cookie:session,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}); if(response.headers.get('set-cookie') && !session) cookie=response.headers.get('set-cookie')!.split(';')[0]!; const result=await response.json(); assert.equal(response.status,200,JSON.stringify(result)); return result as T; }
async function action(action: LabAction) { await sleep(1100); return api<LabActionResult>('actions','POST',{action}); }
describe('the real Kafka Failure Lab', { skip: !API && 'LAB_API_ORIGIN not set' },()=>{
  let state: SubscriptionState='authorizing'; let frames=0; let token: LabToken; let heartbeat: NodeJS.Timeout; let cursor='';
  const feed: LabFeedPage['items'] = [];
  async function poll(){const page=await api<LabFeedPage>(`trace?after=${encodeURIComponent(cursor)}`);cursor=page.next;feed.push(...page.items);return page;}
  before(async()=>{
    await until(async()=>{const status=await api<{benches:{state:string}[]}>('status');return status.benches.some(b=>b.state==='ready');},'ready bench',90_000);
    const lease=await api<LabLease>('lease','POST',{});assert.equal(lease.status,'ready'); token=await api<LabToken>('lease/token','POST',{});
    heartbeat=setInterval(()=>void api('lease').catch(()=>{}),2000);
    client=createClient<LabChannels>({origin:token.gatewayOrigin,path:token.gatewayPath,getToken:async()=>(await api<LabToken>('lease/token','POST',{})).token});
    const view=client.subscribe('station',{channelVersion:1,params:{stationId:'LC-03'}});view.on('state',event=>{state=event.state;});view.on('data',()=>{frames++;});await view.ready({timeoutMs:30_000});
  });
  after(async()=>{clearInterval(heartbeat);await client?.close();if(cookie)await api('lease/return','POST').catch(()=>{});});
  test('public lease, source-backed frames, and cross-session denial',async()=>{
    await until(()=>frames>=2,'Kafka updates'); assert.equal(state,'live');
    const denied=await fetch(`${API}/api/lab/actions`,{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify({action:'relay.cut'})});assert.equal(denied.status,401);
    const selected=await fetch(`${API}/api/lab/actions`,{method:'POST',headers:{origin:SITE,cookie,'content-type':'application/json'},body:JSON.stringify({action:'relay.cut',bench:3})});assert.equal(selected.status,400);
  });
  test('tokens stay on their own bench and edge management routes stay private', { skip: !API?.startsWith('https://') && 'Requires the three-bench Caddy deployment' }, async () => {
    const status = await api<{ benches: { bench: number }[] }>('status');
    for (const other of status.benches.filter(b => b.bench !== token.bench)) {
      const foreign = createClient<LabChannels>({ origin: token.gatewayOrigin, path: `/lab/${other.bench}/socket.io`, getToken: () => token.token });
      try { await assert.rejects(foreign.subscribe('station', { channelVersion: 1, params: { stationId: 'LC-03' } }).ready({ timeoutMs: 5000 })); } finally { await foreign.close(); }
    }
    // Native verification bypasses Caddy; these edge assertions run in containers.
    if (API?.startsWith('https://')) {
      for (const path of [...(process.env['LAB_SERVES_SITE'] === '1' ? [] : ['/lab/']), `/lab/${token.bench}/`, `/lab/${token.bench}/management/v1/health`, `/lab/${token.bench}/bench/v1/status`]) assert.equal((await fetch(`${API}${path}`)).status, 404);
      for (const headers of [{}, { origin: 'https://foreign.test' }]) assert.equal((await fetch(`${API}/lab/${token.bench}/socket.io/?EIO=4&transport=websocket`, { headers })).status, 403);
    }
  });
  test('fouled sensor pauses at the same record and resume processes it',async()=>{
    await action('sensor.foul');await until(async()=>{await poll();return feed.some(i=>i.kind==='record'&&i.outcome==='failed');},'failed LC-03 record');
    const failed=feed.find(i=>i.kind==='record'&&i.outcome==='failed');assert.ok(failed?.kind==='record');await until(()=>state==='stale','stale sensor');
    const restored=await action('sensor.restore');assert.equal(restored.benchState.source.status,'paused');await action('source.resume');await until(()=>state==='live','resumed sensor');
    await until(async()=>{await poll();return feed.some(i=>i.kind==='record'&&i.outcome==='processed'&&i.offset===failed.offset&&i.partition===failed.partition);},'same offset processed');
  });
  test('relay cut turns views stale and restores real Kafka data',async()=>{
    const cut=Date.now();await action('relay.cut');await until(()=>state==='stale','relay stale',21_000);const staleMs=Date.now()-cut;const restore=Date.now();await action('relay.restore');await until(()=>state==='live','relay live',31_000);console.log(JSON.stringify({measurement:'native-or-container-lab',staleMs,restoreMs:Date.now()-restore}));
  });
  test('satellite times out independently while the visitor keeps receiving data',async()=>{
    const startFrames=frames;await action('satellite.start');await until(async()=>{await poll();return feed.some(i=>i.kind==='bench'&&i.event==='satellite-disconnected') && feed.some(i=>i.kind==='trace'&&i.stage==='receipt'&&i.errorCode==='OVERLOADED'&&i.subscriber==='satellite');},'satellite disconnect',15_000);
    assert.equal(state,'live');assert.ok(frames>startFrames);assert.ok(feed.some(i=>i.kind==='trace'&&i.stage==='receipt'&&i.errorCode==='OVERLOADED'&&i.subscriber==='satellite'));
  });
  test('gateway restart preserves lease and resumes the visitor',async()=>{const before=frames;await action('gateway.restart');await until(async()=>{await poll();return state==='live'&&frames>before&&feed.some(i=>i.kind==='bench'&&i.event==='gap');},'gateway restarted');});
  test('feed is redacted; returning revokes the old connection and token',async()=>{
    await poll();const json=JSON.stringify(feed);assert.ok(!json.includes(token.token));for(const item of feed){assert.ok(!('subscriptionId' in item));assert.ok(!('requestId'in item));assert.ok(!('data'in item));if(item.kind==='trace'&&item.stage==='authorize')assert.ok(item.subscriber);}
    await api('lease/return','POST');await until(()=>state==='stale','lease revoked');
    const old=createClient<LabChannels>({origin:token.gatewayOrigin,path:token.gatewayPath,getToken:()=>token.token});try{await assert.rejects(old.subscribe('station',{channelVersion:1,params:{stationId:'LC-03'}}).ready({timeoutMs:5000}));}finally{await old.close();}
  });
});
