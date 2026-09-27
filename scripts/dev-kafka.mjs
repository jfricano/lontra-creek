/** Native Kafka development. Uses existing KAFKA_HOME/JAVA_HOME; never downloads. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const root=resolve(import.meta.dirname,'..');
const kafka=process.env.KAFKA_HOME, java=process.env.JAVA_HOME;
if(!kafka||!java) throw new Error('Set KAFKA_HOME and JAVA_HOME to your existing Kafka 4.1.2 and JDK installations. No software is downloaded.');
await access(join(kafka,'bin/kafka-server-start.sh')); await access(join(java,'bin/java'));
function port(name,fallback){const raw=process.env[name];const n=raw?Number(raw):fallback;if(!Number.isInteger(n)||n<1||n>65535)throw new Error(`${name} must be a valid port`);return n;}
const ports={site:port('LONTRA_SITE_PORT',4321),gateway:port('LONTRA_GATEWAY_PORT',7400),api:port('LONTRA_API_PORT',7402),internal:port('LONTRA_INTERNAL_PORT',7410),broker:port('LONTRA_KAFKA_PORT',19092),controller:port('LONTRA_KAFKA_CONTROLLER_PORT',19093)};
if(new Set(Object.values(ports)).size!==Object.keys(ports).length)throw new Error('Native service ports must be distinct.');
const directory=resolve(process.env.LONTRA_KAFKA_DATA_DIR??join(root,'.local/kafka-dev'));
if(/[\r\n=]/.test(directory))throw new Error('Unsupported data directory characters.');
await mkdir(directory,{recursive:true});
const lock=join(directory,'running.lock');
try{await mkdir(lock);}catch{throw new Error(`Native stack lock exists: ${lock}. Verify no stack uses this directory before removing a stale lock.`);}
await writeFile(join(lock,'pid'),String(process.pid));
const children=[];let stopping=false;let finish;
const done=new Promise(resolve=>{finish=resolve;});
const env={...process.env,JAVA_HOME:java,NODE_ENV:'development',ASTRO_TELEMETRY_DISABLED:'1',KAFKA_HEAP_OPTS:'-Xms512m -Xmx512m',
 FIELD_HOST:'127.0.0.1',FIELD_PORT:String(ports.api),FIELD_INTERNAL_PORT:String(ports.internal),KAFKA_BROKERS:`127.0.0.1:${ports.broker}`,
 FIELD_DATA_DIR:join(directory,'field'),SITE_ORIGIN:`http://127.0.0.1:${ports.site},http://localhost:${ports.site}`,GATEWAY_PUBLIC_ORIGIN:`http://127.0.0.1:${ports.gateway}`,
 FIELD_STATION_INTERNAL_URL:`http://127.0.0.1:${ports.internal}`,LONTRA_SITE_PORT:String(ports.site),LONTRA_API_PORT:String(ports.api),LONTRA_NATIVE_CONFIG:join(directory,'streamotter.json')};
// This local-only mode must not inherit a production broker's credentials or Lab endpoints.
for(const key of Object.keys(env))if(/^(KAFKA_(?:CA_FILE|FIELD_STATION_|GATEWAY_)|LAB_BENCH|FIELD_LAB_BENCHES)/.test(key))delete env[key];
function command(binary,args){const r=spawnSync(binary,args,{cwd:root,env,stdio:'inherit'});if(r.status!==0)throw new Error(`${binary} failed (${r.status})`);}
function run(name,binary,args,cwd=root){const child=spawn(binary,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});children.push(child);for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>process.stdout.write(`[${name}] ${chunk}`));child.on('error',error=>{console.error(`${name}: ${error.message}`);process.exitCode=1;void stop();});child.on('exit',code=>{if(!stopping){console.error(`${name} exited (${code}); stopping stack.`);process.exitCode=1;void stop();}});return child;}
async function stop(){if(stopping)return;stopping=true;for(const child of children.reverse())try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}resolve();},15000);child.once('exit',()=>{clearTimeout(timer);resolve();});})));await rm(lock,{recursive:true});finish();}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void stop();});
try {
 command('npm',['run','build','-w','@lontra-creek/field-station']);
 const config=JSON.parse(await readFile(join(root,'apps/field-station/streamotter.json'),'utf8'));
 config.gateway.port=ports.gateway;config.gateway.allowedOrigins=env.SITE_ORIGIN.split(',');config.connections.field.brokers=[env.KAFKA_BROKERS];
 await writeFile(env.LONTRA_NATIVE_CONFIG,JSON.stringify(config,null,2));
 const properties=join(directory,'server.properties');
 await writeFile(properties,`process.roles=broker,controller\nnode.id=1\ncontroller.quorum.voters=1@127.0.0.1:${ports.controller}\nlisteners=PLAINTEXT://127.0.0.1:${ports.broker},CONTROLLER://127.0.0.1:${ports.controller}\nadvertised.listeners=PLAINTEXT://127.0.0.1:${ports.broker}\nlistener.security.protocol.map=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT\ncontroller.listener.names=CONTROLLER\ninter.broker.listener.name=PLAINTEXT\nlog.dirs=${directory}/logs\noffsets.topic.replication.factor=1\ntransaction.state.log.replication.factor=1\ntransaction.state.log.min.isr=1\ngroup.initial.rebalance.delay.ms=0\nnum.partitions=3\nauto.create.topics.enable=false\n`);
 try{await access(join(directory,'logs/meta.properties'));}catch{
  const id=spawnSync(join(kafka,'bin/kafka-storage.sh'),['random-uuid'],{env,encoding:'utf8'});if(id.status!==0)throw new Error('Could not generate local Kafka cluster ID');
  command(join(kafka,'bin/kafka-storage.sh'),['format','--cluster-id',id.stdout.trim(),'--config',properties]);
 }
 run('kafka',join(kafka,'bin/kafka-server-start.sh'),[properties]);
 let ready=false;
 for(let i=0;i<30&&!stopping;i++){await new Promise(r=>setTimeout(r,1000));const check=spawnSync(join(kafka,'bin/kafka-broker-api-versions.sh'),['--bootstrap-server',env.KAFKA_BROKERS],{env,stdio:'ignore',timeout:3000});if(check.status===0){ready=true;break;}}
 if(!ready)throw new Error('Local Kafka did not become ready.');
 run('field',process.execPath,['--disable-warning=TimeoutNegativeWarning','src/server/main.ts'],join(root,'apps/field-station'));
 ready=false;for(let i=0;i<60&&!stopping;i++){try{const r=await fetch(`http://127.0.0.1:${ports.api}/healthz`,{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
 if(!ready)throw new Error('Field station did not become ready.');
 run('gateway',process.execPath,['scripts/kafka-gateway.mjs'],join(root,'apps/field-station'));
 const astro=createRequire(join(root,'apps/site/package.json')).resolve('astro/package.json').replace(/package\.json$/,'bin/astro.mjs');
 run('site',process.execPath,[astro,'dev','--ignore-lock'],join(root,'apps/site'));
 console.log(`Kafka demo: http://127.0.0.1:${ports.site}/field-station/ (notebooks enabled; Failure Lab not included).`);
 await done;
}catch(error){console.error(error.message);process.exitCode=1;await stop();}
