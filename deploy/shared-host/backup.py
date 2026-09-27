#!/usr/bin/python3
"""Root-only shared backup adapters. Never restore into a running app volume."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import uuid

ROOT = Path('/srv/apps/lontra')
ENV = Path('/etc/apps/lontra/lontra.env')
LIMIT = 10 * 1024 * 1024
HELPER = """
import {readFileSync,writeFileSync,renameSync,openSync,fstatSync,closeSync} from 'node:fs';
import {createWorld,restore} from '@lontra-creek/sim';
const mode=process.argv[1], path='/var/lib/lontra/world.json';
let text,mtime;
if(mode==='snapshot'){const fd=openSync(path,'r');try{text=readFileSync(fd,'utf8');mtime=fstatSync(fd).mtime.toISOString();}finally{closeSync(fd);}}
else text=readFileSync(mode==='verify'?path:0,'utf8');
if(Buffer.byteLength(text)>10*1024*1024) throw Error('Checkpoint too large');
const c=JSON.parse(text),w=restore(JSON.stringify(c.world));
if(c.format!==1 || !Number.isFinite(Date.parse(c.epoch)) || c.tickMs!==Number(process.env.FIELD_TICK_MS) || Date.parse(c.epoch)!==Date.parse(process.env.FIELD_EPOCH) || w.generation!==Number(process.env.FIELD_GENERATION) || w.seed!==createWorld({seed:'lontra-creek'}).seed) throw Error('Checkpoint does not match configuration');
if(mode==='restore'){writeFileSync(path+'.tmp',text,{mode:0o600});renameSync(path+'.tmp',path);}
else if(mode==='snapshot')process.stdout.write(JSON.stringify({text,mtime}));
else if(mode==='verify')console.log(JSON.stringify({tick:w.tick,epoch:c.epoch}));
else throw Error('Unknown action');
"""


def secure(path, directory=False, private=True):
    path = Path(path)
    info = path.lstat()
    if path.is_symlink() or info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022):
        raise ValueError(f'Expected root-owned private path: {path}')
    if directory and (not stat.S_ISDIR(info.st_mode) or (private and stat.S_IMODE(info.st_mode) != 0o700)):
        raise ValueError('Staging directory must have mode 0700')
    if not directory and not stat.S_ISREG(info.st_mode):
        raise ValueError('Expected regular file')
    # An unprivileged ancestor must not be able to replace the private target.
    for parent in path.absolute().parents:
        p = parent.stat()
        if p.st_uid != 0 or p.st_mode & 0o022:
            # Root-owned sticky /tmp is acceptable for orchestrator staging.
            if not (p.st_uid == 0 and p.st_mode & stat.S_ISVTX):
                raise ValueError(f'Unsafe ancestor: {parent}')
        if parent.is_symlink():
            raise ValueError('Symlink ancestor')
    return path


def run(args, data=None):
    result = subprocess.run(['docker', *args], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=180, check=False)
    if result.returncode:
        # Docker output may contain environment values. Do not echo it.
        raise RuntimeError(f'Docker {args[0]} failed ({result.returncode})')
    return result.stdout


def env_values(path):
    secure(path)
    values = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise ValueError('Expected literal KEY=value env file')
        values[key] = value
    return values


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checkpoint(data):
    if len(data) > LIMIT:
        raise ValueError('Checkpoint exceeds 10 MiB')
    c = json.loads(data)
    if c.get('format') != 1 or not isinstance(c.get('world'), dict):
        raise ValueError('Invalid checkpoint')
    return c


def write_new(path, data):
    with open(path, 'xb') as output:
        os.chmod(path, 0o600)
        output.write(data)


def snapshot(stage):
    values = env_values(ENV)
    values.update(env_values(ROOT / 'current.env'))
    config = Path(values['LONTRA_CONFIG_DIR'])
    if config.parent != ROOT / 'releases' or not re.fullmatch(r'[a-f0-9]{40}', config.name):
        raise ValueError('Expected a release SHA configuration directory')
    secure(config, True, private=False)
    files = ['compose.yaml', 'compose.shared.yaml', 'Caddyfile.shared', 'start-caddy-shared.sh', 'kafka/start.sh']
    lab = config / 'lab.enabled'
    if lab.exists() or lab.is_symlink():
        secure(lab, private=False)
        files += ['compose.lab.yaml', 'compose.shared.lab.yaml']
    hashes = {}
    for name in files:
        secure(config / name, private=False)
        hashes[name] = digest((config / name).read_bytes())
    compose = ['compose', '--project-name', 'lontra-creek', '--project-directory', str(config),
               '--env-file', str(ENV), '--env-file', str(ROOT / 'current.env'),
               '-f', str(config / 'compose.yaml')]
    if lab.exists():
        compose += ['-f', str(config / 'compose.lab.yaml')]
    compose += ['-f', str(config / 'compose.shared.yaml')]
    if lab.exists():
        compose += ['-f', str(config / 'compose.shared.lab.yaml')]
    container = run([*compose, 'ps', '-q', 'field-station']).decode().strip()
    if not re.fullmatch(r'[a-f0-9]{12,64}', container):
        raise ValueError('Expected exactly one running field station')
    before = json.loads(run(['inspect', container]))[0]
    image = before['Image']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('Expected immutable Docker image ID')
    if before['Config']['Image'] != values['LONTRA_IMAGE']:
        raise ValueError('Running image differs from active release configuration')
    if not before['State']['Running']:
        raise ValueError('Field station is not running')
    captured = json.loads(run(['exec', container, 'node', '--input-type=module', '-e', HELPER, 'snapshot']))
    data = captured['text'].encode()
    written = datetime.datetime.fromisoformat(captured['mtime'].replace('Z', '+00:00'))
    c = checkpoint(data)
    after = json.loads(run(['inspect', container]))[0]
    if before['State']['StartedAt'] != after['State']['StartedAt'] or not after['State']['Running']:
        raise ValueError('Station restarted during snapshot')
    mounted = [m for m in before['Mounts'] if m['Destination'] == '/var/lib/lontra']
    if len(mounted) != 1 or mounted[0]['Type'] != 'volume':
        raise ValueError('Expected named field-data volume')
    manifest = dict(format=1, createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    checkpointWrittenAt=captured['mtime'], checkpointAgeSeconds=max(0, (datetime.datetime.now(datetime.timezone.utc) - written).total_seconds()),
                    release=config.name, imageId=image, releaseImage=values['LONTRA_IMAGE'],
                    configHashes=hashes, helperHash=digest(HELPER.encode()),
                    checkpointSha256=digest(data), epoch=c['epoch'], tickMs=c['tickMs'],
                    generation=c['world']['generation'], tick=c['world']['tick'],
                    sourceVolume=mounted[0]['Name'], kafka='Not included; ephemeral streams and notebooks')
    # Manifest is the completion marker. A failed partial snapshot cannot verify.
    write_new(stage / 'lontra-world.json', data)
    write_new(stage / 'lontra-manifest.json', json.dumps(manifest, indent=2).encode())


def verify(stage):
    for name in ['lontra-world.json', 'lontra-manifest.json']:
        secure(stage / name)
    data = (stage / 'lontra-world.json').read_bytes()
    c = checkpoint(data)
    m = json.loads((stage / 'lontra-manifest.json').read_bytes())
    if m.get('format') != 1 or m.get('checkpointSha256') != digest(data) or m.get('helperHash') != digest(HELPER.encode()):
        raise ValueError('Manifest/checkpoint integrity mismatch')
    for key, value in [('epoch', c['epoch']), ('tickMs', c['tickMs']), ('generation', c['world']['generation']), ('tick', c['world']['tick'])]:
        if m.get(key) != value:
            raise ValueError('Manifest metadata mismatch')
    image = m['imageId']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('Expected immutable image ID')
    # Require the exact retained image locally: no network/pull or tag substitution.
    run(['image', 'inspect', image])
    volume = 'lontra-backup-verify-' + uuid.uuid4().hex
    name = volume + '-container'
    run(['volume', 'create', '--label', 'lontra.backup=disposable', volume])
    try:
        base = ['run', '--rm', '--name', name, '--pull', 'never', '--network', 'none',
                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--cgroup-parent', 'lontra.slice', '--memory', '256m', '--cpus', '0.25', '--pids-limit', '64', '--user', '1000:1000',
                '--mount', f'type=volume,src={volume},dst=/var/lib/lontra',
                '--env', 'FIELD_EPOCH=' + str(m['epoch']), '--env', 'FIELD_TICK_MS=' + str(m['tickMs']),
                '--env', 'FIELD_GENERATION=' + str(m['generation']), '--entrypoint', 'node', image,
                '--input-type=module', '-e', HELPER]
        # Two fresh containers prove the restored file survives process exit.
        run([*base[:1], '-i', *base[1:], 'restore'], data)
        report = json.loads(run([*base, 'verify']))
        if report != {'tick': m['tick'], 'epoch': m['epoch']}:
            raise ValueError('Restored simulation differs')
    finally:
        # Also remove a container left alive after a subprocess timeout.
        with contextlib.suppress(Exception):
            run(['rm', '-f', name])
        run(['volume', 'rm', volume])
    write_new(stage / 'lontra-verified.json', json.dumps(dict(checkpointSha256=digest(data), imageId=image,
              disposableRestore=True, verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())).encode())


def interrupted(signum, frame):
    raise InterruptedError('Backup interrupted')


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[1] not in ['snapshot', 'verify']:
        raise ValueError('Usage (root only): lontra-{snapshot,verify} ROOT_OWNED_0700_STAGING_DIR')
    stage = secure(Path(sys.argv[2]).absolute(), True)
    secure(ROOT, True)
    lock_path = ROOT / 'deploy.lock'
    if lock_path.exists() or lock_path.is_symlink():
        secure(lock_path)
    with open(lock_path, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        globals()[sys.argv[1]](stage)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Lontra backup failed: {error}', file=sys.stderr)
        sys.exit(1)
