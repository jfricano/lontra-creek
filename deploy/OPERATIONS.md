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
The production demo accepts only the `streamotter.app` origin and its session
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
A pull failure leaves the running stack untouched. An interrupted SSH/session
or host power loss requires inspecting actual container health and rerunning
an approved deploy; the on-disk last-success record alone is not health proof.

For an intentional rollback, dispatch the previous full SHA again, or on the
host run:

```sh
sudo cat /srv/lontra/previous.sha
sudo /usr/local/sbin/lontra-deploy <previous-full-sha>
```

Current and previous env/SHA records live in `/srv/lontra`. Do not print env files
into logs. Rollback covers the application image and its env, **not** schema,
Kafka data, study history, certificates, or edits to the installed Compose and
Caddy configuration. Reverting a config update requires restoring its audited
checkout/config before deploying. History-changing simulation releases need a
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
with the overlay first (without deleting volumes). The deployment/checkpoint
commands include the overlay while that marker exists. The base stack remains
independently operable. Never use `compose.lab-spike.yaml` on a public host.

New secrets are generated for new hosts. `make-secrets.sh` preserves existing
env files by design; an existing host needs the nine per-bench values appended
by its operator. Use `openssl rand -hex 32` for each missing value in a root-only
session; never regenerate the production SCRAM passwords. Existing Kafka data
also needs the three SCRAM users installed via the loopback admin listener
before enabling benches; formatting is only for new volumes. Reissue the
broker certificate using the existing CA with `lab-1-kafka lab-2-kafka
lab-3-kafka` SANs (setup does this) and restart Kafka under a maintenance plan.

**Unresolved R2 release risk:** unique SCRAM identities do not enforce Kafka
topic/group ACL confinement. A compromised bench that possesses its Kafka
credential could access another bench's or production topics. The PM retained
this contract residual risk for the preparation increment on September 27;
public bench deployment remains gated on owner disposition or a subsequent
ACL hardening change. Do not describe this as Kafka least privilege.

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
