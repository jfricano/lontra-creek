/** Validate resolved Compose and actual container configuration without printing secrets. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let memory=0, cpus=0;
for (const [name, service] of Object.entries(config.services)) {
  assert.equal((service.ports ?? []).length, 0, `${name} publishes a host port`);
  const nets=Object.keys(service.networks ?? {default:null});
  const edge=nets.filter(key => config.networks[key]?.name === 'edge-lontra');
  assert.equal(edge.length, name==='caddy'?1:0, `${name} edge attachment`);
  assert.deepEqual(nets.sort(), name==='caddy'?['default',...edge].sort():['default']);
  assert.equal(service.cgroup_parent,'lontra.slice');
  assert.ok(!service.privileged && !service.network_mode && !service.pid && !service.ipc);
  assert.ok(!(service.volumes??[]).some(v=>(v.source??'').includes('docker.sock')));
  assert.equal(service.logging.options['max-size'],'10m');
  assert.equal(service.logging.options['max-file'],'3');
  assert.ok(Number(service.mem_limit)>0 && Number(service.pids_limit)>0 && Number(service.cpus)>0, `${name} has enforced resource limits`);
  memory+=Number(service.mem_limit);cpus+=Number(service.cpus);
}
assert.ok(memory<=5*1024**3, `memory total ${memory}`);assert.ok(cpus<=1.00001, `CPU total ${cpus}`);
assert.ok(!config.services.kafka.environment.KAFKA_HEAP_OPTS.includes('AlwaysPreTouch'));
assert.ok(config.services.caddy.networks[Object.keys(config.networks).find(k=>config.networks[k].name==='edge-lontra')].aliases.includes('lontra-caddy'));
if(process.argv[3]) {
  const containers=JSON.parse(readFileSync(process.argv[3],'utf8'));
  assert.equal(containers.length,Object.keys(config.services).length);
  assert.deepEqual(containers.map(c=>c.Config.Labels['com.docker.compose.service']).sort(),Object.keys(config.services).sort());
  for(const container of containers) {
    const name=container.Config.Labels['com.docker.compose.service'];
    const expected=config.services[name];assert.ok(expected);
    assert.equal(container.HostConfig.Memory,Number(expected.mem_limit));
    assert.equal(container.HostConfig.NanoCpus,Math.round(Number(expected.cpus)*1e9));
    assert.equal(container.HostConfig.PidsLimit,Number(expected.pids_limit));
    assert.equal(container.HostConfig.MemorySwap,Number(expected.memswap_limit));
    assert.equal(container.HostConfig.Privileged,false);
    assert.notEqual(container.HostConfig.NetworkMode,'host');
    assert.ok(!(container.Mounts??[]).some(m=>(m.Source??'').includes('docker.sock')));
    assert.equal(Object.keys(container.HostConfig.PortBindings??{}).length,0);
    assert.deepEqual(Object.keys(container.NetworkSettings.Networks).sort(),Object.keys(expected.networks??{default:null}).map(k=>config.networks[k].name).sort());
    assert.equal(container.State.OOMKilled,false);
    assert.equal(container.HostConfig.CgroupParent,'lontra.slice');
    const membership=readFileSync(`/proc/${container.State.Pid}/cgroup`,'utf8');
    assert.match(membership,/0::\/lontra\.slice\//);
  }
}
console.log(`Verified ${Object.keys(config.services).length} services: zero published ports, isolated edge, ${memory/1024**2} MiB ceilings, ${cpus.toFixed(2)} CPU ceiling.`);

if(process.argv[3]) {
  assert.equal(readFileSync('/sys/fs/cgroup/lontra.slice/memory.max','utf8').trim(),'5368709120');
  const [quota,period]=readFileSync('/sys/fs/cgroup/lontra.slice/cpu.max','utf8').trim().split(' ').map(Number);
  assert.equal(quota/period,1);
  assert.equal(readFileSync('/sys/fs/cgroup/lontra.slice/memory.swap.max','utf8').trim(),'0');
  assert.equal(readFileSync('/sys/fs/cgroup/lontra.slice/pids.max','utf8').trim(),'2048');
}
