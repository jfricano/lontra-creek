# Deployment candidate and operator runbook

E5.1–E5.5 and E2.3, prepared September 27, 2026. This is a **review-ready implementation**,
not a deployed system. The setup rehearsal must pass in GitHub Actions before
server use. No accounts, environment protections, credentials, cloud resources,
registry publication, or public deployment were created by this change.

The product/hosting decisions remain in [PLAN](../docs/PLAN.md),
[deployment plan](../docs/DEPLOYMENT_PLAN.md), and
[owner checklist](../docs/HOSTING.md). This file is the operator procedure and
verification record for the scripts, not a replacement hosting budget. Prices
and entitlements in older planning documents must be rechecked by the owner
before committing resources.

## Before enabling anything

The workflows default to disabled. An owner must approve the destination and
release, then configure the following in GitHub:

| Workflow | Enable variable | Environment / configuration |
| --- | --- | --- |
| `images.yml` | `LONTRA_IMAGES_ENABLED=true` | `registry`: approve public GHCR publication and retention. Environment must allow main only. Workflow token needs packages write. Initial package visibility must be set by owner; unauthenticated host pulls require public visibility. |
| `deploy.yml` | `LONTRA_DEPLOY_ENABLED=true` | `production`: required owner reviewer, prevent self-review as appropriate, main only; secrets `DEPLOY_HOST`, `DEPLOY_KEY`, `DEPLOY_KNOWN_HOSTS`. |
| `site.yml` | `LONTRA_SITE_ENABLED=true` | `preview` and `production`: owner review and main-only branch restriction; scoped `CLOUDFLARE_API_TOKEN`, variables `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`. |

Environment protection is an **out-of-band prerequisite**: a YAML environment
name does not create required reviewers. Do not set enable variables until
protections, secrets, and approvals are configured. Never put application
secrets in GitHub. DEPLOY_KEY is the separate restricted credential, never an
operator's login key. Obtain the host public key through a trusted server
console and store its full known_hosts line; the workflow never trusts a fresh
`ssh-keyscan` result.

Cloudflare Pages is the prepared static adapter. Provision an approved Direct
Upload project with `main` as its production branch before enabling it; the
workflow does not create one. `staging` uploads are previews; default dispatch
is preview. The command follows Cloudflare's [Direct Upload documentation](https://developers.cloudflare.com/pages/get-started/direct-upload/)
and [Pages command reference](https://developers.cloudflare.com/workers/wrangler/commands/pages/).
The owner's choice of Pages, account limits, token scope, and acceptance of its
public preview URL remain prerequisites. No claim about present free-tier
capacity is made here.

**Preview limitation:** a `pages.dev` preview is suitable for static review.
The production demo accepts only the `streamotter.dev` origin and its session
cookie is SameSite=Strict. Cross-site previews therefore cannot complete the
live walkthrough. Full staging needs an explicitly approved same-site staging
host and matching server/gateway origin configuration, or testing at the final
origin before announcing it. Do not weaken CORS or cookie policy to make a
random preview work. Public preview deployment still requires owner authority.

## Prepare the server

Use the already approved Ubuntu 24.04 host and an audited checkout. The operator
securely transfers the origin certificate, origin private key, and the **public**
SSH deploy key directly to the server. Do not send private keys through chat,
commit them, or put them into workflow artifacts.

```sh
sudo deploy/setup.sh /root/origin-cert.pem /root/origin-key.pem \
  /root/lontra-deploy.pub 2026-09-27T00:00:00Z
```

Choose the actual study epoch before the first run. Repeating setup preserves
the existing epoch, app secrets, and Kafka CA. It refreshes the supplied origin
certificate, deploy public key, trusted scripts, and stack config. This is an
operator-only config update; review config changes before rerunning on a live
host. Setup starts Docker but does not start the application.

Setup installs Ubuntu's Docker/Compose packages if Compose is absent; it uses
an existing Docker/Compose installation otherwise. It preserves existing
firewall rules and opens host TCP 443. Cloud network firewall rules and SSH
access remain the operator's job. Docker-published ports traverse FORWARD, so
host INPUT rules alone are not a reliable Docker port restriction. This stack
publishes only 443; do not add management/broker ports. The existing Caddy
configuration handles trusted Cloudflare client IP ranges.

`/srv/lontra` is root-only. `stack.env`, current/previous deployment env files,
and the CA private key are root-readable only. Mounted public CA and broker
keystore files must be readable by container UIDs; host access is blocked by
the root-only ancestor. The origin key is likewise within that protected
ancestor. Do not copy these trees into CI artifacts or backups accessible to
untrusted readers. The `lontra-deploy` user has no Docker-group membership added
by setup, its root-owned authorized_keys uses `restrict` and a forced command,
and the command accepts only `deploy <40-character lowercase commit SHA>`.
No shell, SCP, forwarding, arbitrary image name, or additional argument is
accepted by that credential. Docker and this root deployment script are
privileged; operators must audit them and the published image.

## Deploy and recover

1. Confirm candidate checks, independent review, owner acceptance, GHCR
   publication, and retention of both new and previous commit tags.
2. Dispatch `Deploy demo` from main with the full published SHA. Approve the
   protected environment. The host serializes deployments, pulls that exact
   commit tag, and waits up to 300 seconds for Compose health checks.
3. Confirm the workflow succeeded and manually smoke-test the public site,
   credentials, live data, and reconnect behavior. Container health is not a
   substitute for the complete hosted acceptance checks.

On health failure, the script reapplies the last successful env file and waits
for health again. It returns failure even when rollback succeeds. If the first
deployment fails, it stops the new stack **without deleting data volumes**.
`ROLLBACK FAILED` means an operator must intervene; it does not report success.
A pull failure leaves the running stack untouched. A deploy also refuses,
before pulling, a `stack.env` that would lower `KAFKA_AUTHORIZATION` (Kafka
authorization, below). An interrupted SSH/session
or host power loss requires inspecting actual container health and rerunning
an approved deploy; the on-disk last-success record alone is not health proof.

For an intentional rollback, dispatch the previous full SHA again, or on the
host run:

```sh
sudo cat /srv/lontra/previous.sha
sudo /usr/local/sbin/lontra-deploy <previous-full-sha>
```

Current and previous env/SHA records live in `/srv/lontra`. Do not print env files
into logs. Each candidate snapshots the installed Compose, Caddy, Kafka startup,
and checkpoint helper config under `/srv/lontra/releases/`; its root-only env
records `LONTRA_CONFIG_DIR`. Health/checkpoint operations and rollback read that
snapshot, including the release's Lab-enabled marker. A later setup can update
the config template without mutating the running or previous release. Failed
candidates roll back the prior image, env, and matching config, and remove
orphan services introduced by the failed topology. Rollback does **not** revert
schema, Kafka data, study history, or certificates. Keep both retained release
config directories; no automatic deletion of config snapshots is performed. History-changing simulation releases need a
higher generation and a compatibility/recovery plan before acceptance. Never
use `down --volumes` on the real host as a rollback.

`LONTRA_REHEARSAL=1` skips the registry pull only for a root-invoked CI rehearsal
with a locally built commit tag. The SSH forced command invokes sudo with its
normal environment sanitization and never accepts this flag from its input.
Do not enable it for production deployments.

## Evidence and remaining verification

Local checks on Node 26.9.0 (macOS), September 27, 2026:

- `bash -n deploy/setup.sh deploy/operations/deploy.sh deploy/operations/ssh-command.sh`: passed.
- `node --test deploy/test/operations.test.ts`: 6 passed. Tests exercise success,
  failed-candidate recovery, failed rollback, first-deploy cleanup preserving
  volumes, and injection refusal with fake Docker/flock. Additional tests verify
  actual checkpoint serialization/restore and study-mismatch rejection using
  the simulation, plus disabled instance-scoped alarm definition generation. The fixture replaces
  only the fixed root path and root guard; it is not a real container test.
- `npm run typecheck`: passed, including the new deployment tests.
- All four new workflow YAML files parsed with PyYAML; this is syntax parsing,
  not GitHub Actions semantic validation.
- `git diff --check`: passed.

Unrun: actual Ubuntu package installation/firewall changes, real SSH login,
Docker image build, ARM setup twice + whole-stack tests + rollback,
registry publication, and Cloudflare/server deployment. There is no local
Docker; `.github/workflows/setup-rehearsal.yml` supplies the ARM container
rehearsal on a disposable GitHub runner. That runner already has Docker, so it
exercises the existing-Docker setup path; the package-install path additionally
needs verification on a fresh approved Ubuntu host. Never run setup against
this Mac. Hosted staging/load verification and running the integrated production Failure
Lab remain unverified. Prepared E5.5 tooling is described below.

## Production Lab overlay (E2.3)

`compose.lab.yaml` adds three benches and three relay proxies, with individual
SCRAM passwords, service tokens, and relay tokens. No bench receives a
production signing key, the production internal API token, or another bench's
credentials. The field station holds all three service tokens and supplies
restricted per-bench snapshots; proxies hold only their own relay token.
Caddy exposes only `/lab/1/socket.io/*` through `/lab/3/socket.io/*` and rejects
missing/foreign Origin before proxying. Management stays on each bench's
loopback; the internal API, snapshot API, and relay control publish no ports.

The Lab overlay is **off by default**, including after setup. After its backend
and container checks pass and the owner accepts public development gateways,
an operator can create `/srv/lontra/lab.enabled` before deploying. Remove that
marker only during an explicit topology change; stop obsolete lab services
with the overlay first (without deleting volumes). The next deployment snapshots that marker, and checkpoint/health operations
use the current release's saved topology. Existing-host missing Lab keys fail
Compose validation before any running service is replaced; this is a hard
preflight failure, not a partially enabled Lab. The base stack remains
independently operable. Never use `compose.lab-spike.yaml` on a public host.

New secrets are generated for new hosts. `make-secrets.sh` preserves existing
env files by design; an existing host needs the nine per-bench values appended
by its operator. Use `openssl rand -hex 32` for each missing value in a root-only
session; never regenerate the production SCRAM passwords. Existing Kafka data
also needs the three SCRAM users installed via the loopback admin listener
before enabling benches; formatting is only for new volumes. Reissue the
broker certificate using the existing CA with `lab-1-kafka lab-2-kafka
lab-3-kafka` SANs (setup does this) and restart Kafka under a maintenance plan.

**R2 (Kafka authorization) is closed for local and CI stacks only.** With
`KAFKA_AUTHORIZATION=acl`, `kafka/start.sh` enforces least-privilege ACLs per
Kafka user (Lab contract 10.9). The hosted broker still runs without an
authorizer (`compose.yaml` defaults to `none`), so on the host a compromised
bench that possesses its Kafka credential could still access another bench's
or production topics. Public bench deployment and any hosted quarantine
exercise stay gated on the owner approving and running the migration below. Do
not describe the hosted broker as Kafka least privilege until it has.

## Workbench sandbox overlay (W9a)

`compose.sandbox.yaml` adds the `sandbox` service (LC11-ADR-04, sandbox contract
§§9–10): three synthetic workbench slots on the published StreamOtter seam, run
from the same image with `node src/sandbox/sandbox-main.ts`. Its environment is
`NODE_ENV`, `SANDBOX_SERVICE_TOKEN`, `SANDBOX_SLOTS`, and `SITE_ORIGIN` only; the
service refuses to start with any `FIELD_STATION_*` value, Kafka credential, or
`LAB_*_TOKEN`. It publishes no port. The field station reaches its API at
`sandbox:7620` with the shared token; slot N's development gateway listens on
`sandbox:760N`, and each slot's management handler listens on loopback inside
the container only. `deploy/Caddyfile` routes `/sandbox/1/socket.io/*` through
`/sandbox/3/socket.io/*` to those gateways for the site's exact Origin only
(403 otherwise); every other `/sandbox/*` path falls through to 404. It also
accepts sandbox candidate bodies up to 72 KB on
`/api/sandbox/wb/v1/config/*`; every other `/api` body stays at 8 KB.

The overlay is used by `npm run dev:lab` (docs/LOCAL_LAB.md). **It is not part of
any host deployment**: `operations/deploy.sh`, `health.sh`, and `checkpoint.sh`
do not add it, and enabling it on the host is a separate, owner-approved
change. `Caddyfile.shared` and `compose.shared*.yaml` have no sandbox routes yet.

`make-secrets.sh` writes `SANDBOX_SERVICE_TOKEN` into new env files only. An
existing env file (a host's, or a local Lab directory from before the sandbox)
needs it appended once, in a root-only session for a host:

```sh
printf 'SANDBOX_SERVICE_TOKEN=%s\n' "$(openssl rand -hex 32)" >> <env-file>
```

then recreate `field-station` and `sandbox` together so both read the same value.
`npm run dev:lab` appends it to its own `.local/` env file when missing.

## Kafka authorization (LC11-ADR-03)

**Requires the owner's explicit approval before it is run on the hosted
broker.** It is a deployment-plan amendment: nothing in setup or deployment
applies it on its own, and `make-secrets.sh` never adds the setting.

What it changes: `KAFKA_AUTHORIZATION` in `/srv/lontra/stack.env` selects how
`kafka/start.sh` configures the broker. `none` (the default in `compose.yaml`)
is today's broker with no authorizer. `acl` enables KRaft's
`StandardAuthorizer` with `allow.everyone.if.no.acl.found=false`, makes the
loopback listeners' `User:ANONYMOUS` the only super user, and on every start
grants the gateway, the field station, and each `lab-N` bench user exactly the
ACLs in Lab contract 10.9, creates each bench's `lab-N.quarantine` topic, and
only then reports healthy. `migrate` is `acl` with
`allow.everyone.if.no.acl.found=true`, which Kafka applies per resource, not
per operation. On every topic or group that has any grant (every `field.`,
`creek.`, `lab-N.`, `streamotter-lab-N-`, `streamotter-lontra-creek-` and
`lontra-field-station-read-` name), `migrate` enforces exactly as `acl` does:
an operation nobody is granted there, such as reading `field.gauges`' configs,
is denied and fails at once. Only resources nobody is granted stay open: the
cluster itself (and with it creating and deleting any topic, which Kafka allows
to a user with `Create` or `Delete` on the cluster, and reading broker
configs), and topics and groups outside every granted prefix. Kafka logs those
allowed operations at DEBUG only, below the authorizer log's default INFO, so
they leave no trace unless step 3 raises it. CI (`Stack`, `Lab spike`, `Shared host adapter`) and the
local Lab (`compose.local-lab.yaml`) run `acl`; a new volume there gets its
ACLs on first start.

A KRaft broker stores ACLs in its metadata log and accepts them only once an
authorizer is configured, so "ACLs before enforcement" means the `migrate`
step below. Each step restarts Kafka: run it in a maintenance window with
recovery copies of `/srv/lontra/stack.env` and the last world checkpoint (the
checkpoint section below). `$compose` is the deployed release's command, for
example `sudo docker compose -f <release config>/compose.yaml [-f
<release config>/compose.lab.yaml] --env-file /srv/lontra/current.env`, where
`<release config>` is `current.env`'s `LONTRA_CONFIG_DIR`. Each deploy makes a
new release directory, so set `$compose` again after steps 2 and 4.

Set the mode only in `/srv/lontra/stack.env` and apply it with a deploy.
Every deploy builds its candidate env from `stack.env` alone and then replaces
`current.env` with it, so a line written only into `current.env` is dropped by
the next routine deploy and Kafka silently returns to `none`. `lontra-deploy`
refuses a `stack.env` that would lower `KAFKA_AUTHORIZATION` below the running
release's (`acl` > `migrate` > `none`, and unset is `none`); only the rollback
below overrides that. Redeploying the running release applies the change:

```sh
sudo /usr/local/sbin/lontra-deploy "$(sudo cat /srv/lontra/current.sha)"
```

1. **Preflight.** The deployed release must include this `kafka/start.sh` and
   `compose.yaml` (`KAFKA_AUTHORIZATION` in the kafka service, and the health
   check that waits for `/tmp/lontra-kafka.ready`). Confirm the SCRAM users
   exist: `$compose exec kafka /opt/kafka/bin/kafka-configs.sh
   --bootstrap-server 127.0.0.1:9092 --describe --entity-type users` lists
   `gateway`, `field-station`, and, with the Lab, `lab-1` to `lab-3`. Prefix
   every Kafka tool call in this section with `env
   KAFKA_HEAP_OPTS=-Xmx256m` after `exec kafka`, or it starts with the
   broker's 3 GB pre-touched heap.
2. **Install the ACLs without enforcing them.** Stop the clients so none
   reconnects while the grants are being added: `$compose stop caddy gateway
   field-station` (and `lab-1 lab-2 lab-3 lab-1-kafka lab-2-kafka
   lab-3-kafka` with the Lab). Append `KAFKA_AUTHORIZATION=migrate` to
   `/srv/lontra/stack.env` and redeploy the running release (above). Kafka is
   recreated, reports healthy only after the bootstrap, and the clients start
   after it. If the release is not healthy within the deploy's 300 seconds,
   the deploy restores the previous env without the line: remove it from
   `stack.env` too before investigating.
3. **Verify under `migrate`.**
   - `$compose logs kafka | grep 'Kafka authorization'` reports `migrate`,
     19 grants with three benches (4 without the Lab), and the quarantine
     topics.
   - `$compose exec kafka grep -E '^(authorizer|allow|super)'
     /tmp/lontra-kafka.properties` shows the authorizer, `true`, and
     `User:ANONYMOUS`.
   - `$compose exec kafka /opt/kafka/bin/kafka-acls.sh --bootstrap-server
     127.0.0.1:9092 --list` matches Lab contract 10.9's grants, nothing more.
   - `lontra-health`, the site, a live view, a notebook sighting, and (with
     the Lab) a lease and a reset all work.
   - Make the operations `migrate` lets through visible: `$compose exec kafka
     env KAFKA_HEAP_OPTS=-Xmx256m /opt/kafka/bin/kafka-configs.sh
     --bootstrap-server 127.0.0.1:9092 --alter --entity-type broker-loggers
     --entity-name 1 --add-config kafka.authorizer.logger=DEBUG`. At DEBUG the
     authorizer logs every allowed request, so watch the disk and keep the
     window to the hour below.
   - After at least one hour of normal traffic, including a Lab reset, search
     the authorizer logs, which roll hourly: `$compose exec kafka sh -c "grep
     -h -E 'is Denied|DefaultAllow' /opt/kafka/logs/kafka-authorizer.log*"`.
     An `is Denied` line for `User:gateway`, `User:field-station`, or a
     bench's own `lab-N.*` topics, `streamotter-lab-N-` groups, and
     `streamotter-lontra-creek-lab-N-quarantine-read-` groups is a missing
     grant on a granted resource, already failing: stop and roll back. A
     `based on rule DefaultAllow` line for one of those users is an operation
     on a resource nobody is granted, which `acl` will deny: stop and roll
     back, except `IdempotentWrite` or `Create` on
     `Cluster:LITERAL:kafka-cluster`, which Kafka checks again on the topic,
     where the grants cover it (KIP-679 and topic `Create`).
   - Return the logger to INFO: the same `kafka-configs.sh` command with
     `--add-config kafka.authorizer.logger=INFO`. (Step 4's restart also
     resets it.)
4. **Enforce.** Change the line in `/srv/lontra/stack.env` to
   `KAFKA_AUTHORIZATION=acl` and redeploy the running release; Kafka restarts
   and the clients reconnect after it.
   Repeat step 3's checks with `acl` and `false` expected. For the probe
   matrix, run `deploy/test/kafka-acls.test.ts` against the host with
   `STACK_KAFKA_EXEC="$compose exec -T"` and `STACK_KAFKA_BENCHES="1 2 3"` (or
   empty without the Lab). Its probes write only to the bench quarantine
   topics and leave empty groups named `*-acl-probe-*`, which expire. They
   also try writes that must be denied, so the test and the probe script
   refuse to probe a broker that does not deny what no ACL allows (`none` or
   `migrate`): run it only after this step.
5. **Confirm the setting will survive the next deploy:** `sudo grep -H
   '^KAFKA_AUTHORIZATION=' /srv/lontra/stack.env /srv/lontra/current.env`
   prints `acl` for both files, and nothing else. **Record the evidence**
   (commands, output, date) in the deployment record
   and the Lab contract's R2 entry before the Lab's hosted quarantine
   exercises are enabled.

**Rollback.** Set `KAFKA_AUTHORIZATION=none` (or back to `migrate` from
`acl`) in `/srv/lontra/stack.env` and redeploy the running release with the
downgrade allowed, as root: `sudo LONTRA_ALLOW_AUTHORIZATION_DOWNGRADE=1
/usr/local/sbin/lontra-deploy "$(sudo cat /srv/lontra/current.sha)"`. The SSH
deploy credential cannot pass that override. With `none`, the broker has no
authorizer: the stored ACLs and quarantine topics remain but are not enforced,
so returning to `acl` later needs no new bootstrap. To remove the ACLs
entirely, run `kafka-acls.sh --remove --force` with the same resources while
an authorizer is configured. Neither direction touches topic data, SCRAM
users, or the world checkpoint.

**A broker that already runs `acl` or `migrate` picks up added grants on its
next start.** The bootstrap compares the listing with its table and adds only
what is missing, so W9b's two grants per bench (`DescribeConfigs` on
`lab-N.quarantine`, and `Read`/`Delete` on groups prefixed
`streamotter-lontra-creek-lab-N-quarantine-read-`, Lab contract 10.9) need no
operator step beyond starting Kafka once with this `kafka/start.sh` (a deploy
that recreates the `kafka` service, or a restart of it in a maintenance
window). Its log reports the additions: on `npm run dev:lab`, a running
13-grant broker restarted with each grant in turn logged `16 grants, 3 added`,
then `19 grants, 3 added`, and a further start adds nothing. Benches whose profile is `quarantine` need these grants before they
start; with `retry` or `off` they are unused. A broker at `none` is
unaffected.

**Changing a grant later** (a new bench, renamed groups): the bootstrap only
adds. Update `kafka/start.sh` and Lab contract 10.9 together, deploy, and
remove obsolete ACLs by hand with `kafka-acls.sh --remove`; the probe test
fails while the listing has anything extra.

## Checkpoints, monitoring, and rotation (E5.5)

Setup installs `lontra-checkpoint`, `lontra-health`, and systemd units, but does
not enable timers. After a verified first deployment:

```sh
sudo /usr/local/sbin/lontra-checkpoint backup
sudo /usr/local/sbin/lontra-checkpoint verify /srv/lontra/backups/world-TIMESTAMP.json.gz
# Rehearse on staging before restoring on the public host:
sudo /usr/local/sbin/lontra-checkpoint restore /srv/lontra/backups/world-TIMESTAMP.json.gz
sudo /usr/local/sbin/lontra-health
sudo systemctl enable --now lontra-checkpoint.timer lontra-health.timer
```

The backup reads the app's last atomically written checkpoint (normally at most
one hour old), validates it using the installed simulation and configured epoch,
generation and tick length, then atomically saves a root-only compressed copy.
It retains fourteen days locally. The restore validates before stopping the
station/gateway, replaces the checkpoint after their shutdown checkpoint has
completed, and starts services with health verification. The deterministic
world catches up to wall clock. It refuses a checkpoint from a different study
configuration. Operations share the deployment lock.

These are **world checkpoints, not full disaster-recovery backups**. They do
not include Kafka/notebooks, server secrets, certificates, or protection from
loss of the VM disk. An approved encrypted off-host destination and its cost,
retention, access and recovery policy remain an owner decision; no bucket or
transfer job is created here. Notebook expiry/retention remains intentional.
If restore fails after shutdown, inspect the failure and restart the approved
stack after correcting it; do not delete Kafka volumes.

`lontra-health` checks every configured service's health and the existence of a
backup from the last 25 hours. Its timer records failures in systemd/journald;
**it does not send notifications**. Inspect `systemctl --failed` and
`journalctl -u lontra-health -u lontra-checkpoint`. Route failures to an approved
notification destination before unattended operation; host-local checks cannot
report a dead host.

`node deploy/operations/alarm-definitions.mjs <compartment-ocid> <instance-ocid>
<notification-topic-ocid> <output-directory>` writes three disabled OCI alarm
JSON definitions, without calling OCI: memory below 25%, VM infrastructure down,
and VM health telemetry absent. Owner must approve/create the destination,
verify queries with actual metrics, confirm monitoring/IAM/account limits,
review any costs, apply and enable definitions, then trigger and receive a
notification drill. Alarm absence handling detects stopped/no-telemetry cases
that a numeric down-status threshold misses. References checked September 27:
[compute-agent metrics](https://docs.oracle.com/en-us/iaas/Content/Compute/References/computemetrics.htm)
and [VM infrastructure health metrics](https://docs.oracle.com/en-us/iaas/Content/Compute/References/infrastructurehealthmetrics.htm).
The 25% threshold is a planned warning, not a guarantee against reclamation;
budget alerts likewise do not impose a spending cap.

For rotations, preserve a root-only recovery copy first and operate in a
maintenance window. App/service/relay token changes must update both peers and
recreate their containers; rotating the badge/session signing secret ends
existing sessions. Rotate a Kafka user's SCRAM credential **in Kafka first** via
its loopback admin listener, then update that user's env value and recreate
its clients. `make-secrets.sh` does not rotate an existing broker user. Use a
second admin/operator session to verify access before deleting old SSH keys;
rerun setup with the new deploy public key to replace the forced-command key.
Rotate the origin certificate by rerunning setup with the matching pair and
recreating Caddy. Kafka CA rotation is a coordinated trust migration, not
ordinary certificate renewal: preserve the existing CA when adding SANs or
renewing the broker certificate.

Additional verification pending: production Lab container behavior (backend
integration required), Caddy runtime validation, the staging checkpoint restore
drill, enabled timers, OCI query execution and notification delivery. Prepared
setup rehearsal now includes checkpoint backup/verify/restore and health checks;
none has been run on a real host in this workstream.
