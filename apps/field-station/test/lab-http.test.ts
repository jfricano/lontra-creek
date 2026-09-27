import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { publicApi, internalApi } from '../src/server/http.ts';
import { readConfig } from '../src/server/config.ts';
import type { FieldStation } from '../src/server/station.ts';
import type { Notebooks } from '../src/server/notebooks.ts';
const tokens = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
async function serving(server: Server, run: (origin: string) => Promise<void>) { await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); } }
test('Lab public routes preserve origin, session, body, budget and disabled responses', async () => {
  const server = publicApi({ config: readConfig({ SITE_ORIGIN: 'https://site.test' }), station: {} as FieldStation, notebooks: {} as Notebooks });
  await serving(server, async origin => {
    assert.equal((await (await fetch(`${origin}/api/lab/status`)).json() as {enabled:boolean}).enabled,false);
    const foreign = await fetch(`${origin}/api/lab/lease`,{method:'POST',headers:{origin:'https://evil.test'}}); assert.equal(foreign.status,403); assert.equal((await foreign.json() as {code:string}).code,'origin-not-allowed');
    for(const path of ['lease','trace']) assert.equal((await fetch(`${origin}/api/lab/${path}`)).status,401);
    const join = await fetch(`${origin}/api/lab/lease`,{method:'POST',headers:{origin:'https://site.test'}}); assert.equal(join.status,503); assert.match(join.headers.get('set-cookie')!,/HttpOnly/);
    assert.equal(join.headers.get('access-control-allow-origin'),'https://site.test');
    const cookie = join.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(`${origin}/api/lab/lease`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({bench:2})})).status,400);
    assert.equal((await fetch(`${origin}/api/lab/not-a-route`)).status,404);
    let limited = false; for(let i=0;i<25;i++){const r=await fetch(`${origin}/api/lab/status`); if(r.status===429){limited=true;assert.ok(r.headers.get('retry-after'));assert.equal((await r.json() as {code:string}).code,'too-many-requests');break;}} assert.ok(limited);
  });
});
test('per-bench snapshot credentials cannot access another bench or notebooks/holts', async () => {
  const station = {ready:true,view:(id:string)=>id==='station:LC-03'?{revision:'1',data:{stage:2}}:undefined} as unknown as FieldStation;
  const server=internalApi({serviceToken:'production-secret',labTokens:tokens,station,notebooks:{} as Notebooks});
  await serving(server,async origin=>{
    const headers={authorization:`Bearer ${tokens[0]}`};
    assert.equal((await fetch(`${origin}/lab-internal/1/views/station/LC-03`,{headers})).status,200);
    for(const path of ['/lab-internal/2/views/station/LC-03','/lab-internal/1/views/holt/A','/lab-internal/1/views/notebook/someone','/internal/views/notebook/someone']) assert.equal((await fetch(`${origin}${path}`,{headers})).status,401);
    assert.equal((await fetch(`${origin}/lab-internal/1/views/station/LC-03`,{headers:{authorization:'Bearer production-secret'}})).status,401);
  });
});
