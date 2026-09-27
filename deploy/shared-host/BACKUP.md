# Shared-host checkpoint hooks

Preparation only. These adapters do not install themselves or alter the existing
standalone `/srv/lontra` deployment. The shared infrastructure owner installs and
serializes them after approving the separate shared release layout. Python 3 and
Docker CLI/Compose are host prerequisites. No npm or Python dependency install is
needed on the host.

Install reviewed copies as root, mode 0700:

```sh
install -d -o root -g root -m 0700 /usr/local/lib/app-backup-hooks
install -o root -g root -m 0700 deploy/shared-host/backup.py /usr/local/lib/app-backup-hooks/lontra-backup.py
install -o root -g root -m 0700 deploy/shared-host/lontra-snapshot /usr/local/lib/app-backup-hooks/lontra-snapshot
install -o root -g root -m 0700 deploy/shared-host/lontra-verify /usr/local/lib/app-backup-hooks/lontra-verify
```

Both commands take exactly one absolute root-owned, mode-0700 staging directory.
Files and ancestor ownership/permissions are checked; symlinks and writable
ancestors are rejected (root-owned sticky `/tmp` may contain CI staging).
Run each with an orchestrator timeout of 10 minutes. Each Docker command also
has a three-minute timeout. A nonzero exit means failure, including cleanup
failure. Do not classify snapshot alone as a verified or off-host backup.

The shared activation contract is `/srv/apps/lontra` (root:root 0700),
`/etc/apps/lontra/lontra.env` and `/srv/apps/lontra/current.env` (root:root 0600).
The latter defines literal `LONTRA_CONFIG_DIR=/srv/apps/lontra/releases/<40-character-release-SHA>`
and `LONTRA_IMAGE=<retained immutable release image reference>`. No shell expansion,
quoting, or sourcing is performed by the hook. The release directory and immutable config files may be 0755/0644 beneath the
private app ancestor; they must remain root-owned with no group/world write.
Required files are `compose.yaml`, `compose.shared.yaml`, `Caddyfile.shared`,
and `kafka/start.sh`. With `lab.enabled`, also include `compose.lab.yaml` and
`compose.shared.lab.yaml`. Compose applies base, optional Lab, shared, optional
shared Lab in that order.
The Compose project is `lontra-creek`; its running `field-station` must use the
specified image and a named volume mounted at `/var/lib/lontra`.
Shared activation/deployment must acquire `/srv/apps/lontra/deploy.lock` too.
Existing standalone operator scripts do not satisfy this activation contract.

Snapshot runs the simulation's validation in the actual running station image.
It reads `world.json` once: the station writes a temporary file then atomically
renames it, so an open read sees one complete checkpoint. It does not stop the
station, flush Kafka, force an hourly checkpoint, or capture in-memory progress.
A start-time check rejects a station restart during capture. Recovery point is
the last persisted checkpoint (normally hourly, also startup/shutdown).

Outputs are `lontra-world.json` and completion marker `lontra-manifest.json`.
The manifest records SHA-256 checkpoint integrity, release SHA, actual immutable
Docker image ID, configured release image, hashes of release configuration,
epoch, tick size, generation, simulation tick and source volume name. It also records the checkpoint inode
modification timestamp and observed age at capture, without promising freshness. It stores
no environment file, secret, credential, Kafka content or Docker inspect dump.
Keep the matching image and reviewed release configuration available separately;
these files are not a full release export.

Verification requires the exact image locally (`--pull never`), creates a unique
`lontra-backup-verify-*` named volume, and restores into it using a new container
as UID/GID 1000:1000. Docker initializes this new volume from the image's owned
`/var/lib/lontra` directory. A second fresh container opens and validates the
restored file through the simulation library. Both containers have no network,
a read-only image filesystem, dropped capabilities, no-new-privileges, memory/
CPU/process caps, the host-owned `lontra.slice` cgroup parent, and only that
disposable volume. The shared owner must install the reviewed systemd slice
and use Docker's systemd cgroup driver before verification. Only epoch/tick/generation
are passed as environment; no production env file, network, secret or mount is
used. The named container and volume are removed even after restore failure;
`lontra-verified.json` is written only after verification and cleanup succeed.
As with any process, SIGKILL/host failure may interrupt cleanup: the host owner
must remove stale resources labelled `lontra.backup=disposable` only after
confirming no verification is running. Never remove production volumes.

Kafka is explicitly excluded. World streams and notebooks are ephemeral; the
checkpoint reconstructs the deterministic world, not a durable notebook archive
or Kafka offsets/groups. Secret/CA recovery and release config retention are
separate operator obligations. Export, encryption, off-host destination, key
recovery, retention and delivery alerts belong to shared infrastructure and
remain unimplemented here. Keep backup timers disabled until those gates pass.

Focused local tests:

```sh
python3 -m unittest discover -s deploy/shared-host -p 'test_*.py' -v
```

Real isolated-runner acceptance must install the contract paths, start the full
shared Compose fixture and wait for the station checkpoint, then run:

```sh
stage=$(mktemp -d /tmp/lontra-backup.XXXXXX)
chmod 0700 "$stage"
/usr/local/lib/app-backup-hooks/lontra-snapshot "$stage"
/usr/local/lib/app-backup-hooks/lontra-verify "$stage"
test -s "$stage/lontra-verified.json"
```

Also corrupt a copied checkpoint and require verify failure, prove active volume
and live API remain untouched, and check no disposable volume/container remains.
Unit fake-Docker tests establish command boundaries and cleanup; they do not
establish Docker volume initialization or real simulation restore correctness.
