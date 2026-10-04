# LC11-ADR-03 — Private operations and scoped Kafka write authority

Status: **Accepted for local and CI implementation** (October 3, 2026). The hosted broker change waits for Jason's approval. · Slices: W7, W9b · Companion plan §§7, 9, 11 · Lab contract §10.7 R2 · Native: ADR-15C

## Context

V1.1 benches need two new authorities: calling native operator operations (retry-current, reassess, evaluate, redrive, incident reads) and writing quarantine evidence to Kafka. The Lab's threat model accepted one residual risk, **R2: no Kafka authorization**: every SCRAM user can read and write every topic. Each bench already has its own SCRAM user (`lab-1`, `lab-2`, `lab-3`, `deploy/compose.lab.yaml`), which makes attribution and rotation possible but contains nothing. Adding a quarantine writer makes R2 a V1.1 release risk, not a post-launch nicety.

## Decision

### Operator operations stay inside the bench

1. A bench calls the native operator service **in-process** (the Node API the native spec §12 says may share the IPC service's implementation). If a published release only offers local IPC, its socket lives in a protected directory on the bench's own volume, owned by the bench user, never shared with another container, never on the Compose network, and never routed by Caddy.
2. The browser reaches operations only through `POST /api/lab/actions` with a **closed set of intents** (companion plan §9). Each intent resolves to a fixed operation on a server-selected incident for the current study. Requests carry an idempotency key and the expected scenario revision; approvals carry an opaque plan token looked up under the session, lease, and study, never trusted as authority.
3. Operation intent is recorded before execution. A repeated request returns the recorded result; an uncertain one is reported as `unknown` and never silently re-run.
4. Long operations return an accepted operation ID promptly and are polled. The field station's lease coordinator lock is never held across a quarantine write, guard call, evaluation, or gateway restart.

### Kafka authorization: least privilege per principal

Enable the KRaft `StandardAuthorizer` with `allow.everyone.if.no.acl.found=false`, the broker's inter-broker and admin principals as super users, and these ACLs:

| Principal | Allowed |
| --- | --- |
| `gateway` (production) | Read and Describe `field.` and `creek.` topics (including `field.notebooks` and `field.holts`, which it consumes); Read its `streamotter-lontra-creek-` groups |
| `field-station` | Create, Write, and Describe `field.` and `creek.` topics and each bench's `lab-N.field.` and `lab-N.creek.` copies (it is the only application writer); Read `field.notebooks` only; Read and Delete its `lontra-field-station-read-` groups |
| `lab-N` | Read and Describe `lab-N.` topics (its sources and quarantine); Write and DescribeConfigs `lab-N.quarantine` only; Read and Delete groups prefixed `streamotter-lab-N-` and `streamotter-lontra-creek-lab-N-quarantine-read-` |

A bench principal has no access to `field.`, `creek.`, holts, notebooks, another bench's prefix, its own source topics for writing, or topic creation. The field station cannot write a quarantine topic. Quarantine topics are created by the broker's bootstrap with bounded retention, not by benches. `User:ANONYMOUS`, the broker's own loopback listeners, is the only super user.

W7 confirmed the names against the code and corrected this table (October 3, 2026): the overview topic is `creek.overview`, the gateway excludes nothing, the field station's grants are narrower and include `Create`, and bench groups did not yet share the `streamotter-lab-N-` prefix (the code now builds them from `Bench.consumerGroupPrefix`). The authoritative grants, modes (`acl`, `migrate`, `none`), and evidence are in [lab-api.md §10.9](../../../contracts/lab-api.md).

W9b added two grants per bench, each proven necessary by the authorizer's denials on `npm run dev:lab` with StreamOtter 0.2.0-rc.1 (October 4, 2026): **DescribeConfigs** on the literal topic `lab-N.quarantine`, because the quarantine writer checks the topic's `max.message.bytes` at gateway start and the gateway refuses to start without it; and **Read, Delete** on prefixed groups `streamotter-lontra-creek-lab-N-quarantine-read-`, the throwaway group StreamOtter names from the project ID (`lontra-creek-lab-N`) to read evidence back for an evaluation or redrive, and deletes afterwards. The project ID is kept rather than renamed into the existing prefix. No topic setting changes: the bench's `maxSourceRecordBytes` is 262144, within the broker's default message size. `start.sh` only adds grants, so a broker that already has ACLs gains these on its next start with no other step.

### Where it applies

- **Local and CI stacks:** W7 enables the authorizer and ACLs and adds stack tests: a bench cannot read or write another bench's topics, `field.*`, holts, or notebooks; cannot create topics; can write only its own quarantine topic; the production gateway and field station keep working (LC11-A29).
- **Hosted broker:** a deployment-plan amendment, applied only with Jason's explicit approval. Until real ACL evidence exists on the host, quarantine-writing exercises stay local and CI only, and the hosted Lab shows them unavailable with that reason.

## Consequences

- R2 closes for the production gateway too, which the Lab contract already recommended.
- Formatting a new broker volume and running ACL bootstrap become part of `deploy/kafka/start.sh`; an existing volume needs a one-time ACL migration documented in `deploy/OPERATIONS.md`.
- The Lab contract's threat model (§10.4–10.8) gains a quarantine-writer row and a re-verification against the new published release (R4).

## Alternatives considered

- **Separate SCRAM users only.** Rejected: identity without authorization contains nothing (R2).
- **A separate broker or cluster for benches.** Rejected: new infrastructure and cost for a demo, and cross-cluster quarantine writes are rejected by the native spec.
- **A public operator endpoint with tokens.** Rejected by the native spec §12 and the companion plan: no public remediation HTTP endpoint.
