# Failure Lab implementation checkpoint

September 27, 2026 · Local candidate, not deployed

The API types follow `contracts/lab-api.md`. The backend now has a serialized
FIFO lease pool with session/address limits, claim/idle/expiry handling and
per-bench recovery; scoped HTTP routes and snapshot credentials; opaque bench
lease tokens; and a Kafka-only bench with all seven scenario actions. Holts and
notebooks are excluded from bench channels, topic copies and snapshots.
Management stays on explicit loopback with no registered development principals.
The feed replaces private identifiers, drops handshake/map noise, caps history,
and rejects cursors from another lease. Reset invalidates tokens immediately,
revokes the old subject, restores the relay/calibration, starts a fresh consumer
group and deletes the old group. Gateway restart returns promptly; token/feed
reads and reset invalidation remain available during the lifecycle operation.

Verification to date:

- Typecheck and field-station compiled build passed.
- 115 unit/integration/security tests passed, including fake-clock lease state,
  concurrent grants, address quotas, action rate limits, redaction/cursor bounds,
  forbidden bench secrets, production config validation and scoped snapshots.
- Native Node 24 + Kafka 4.1.2 over TLS/SCRAM on this Mac exercised actual live
  frames, failed LC-03 record then same-offset resume, cut/restore, satellite
  receipt timeout while the visitor kept receiving data, restart, redaction,
  early-return revocation and old-token denial. Latest completed scenario run
  passed; relay became stale in 14.1 seconds and live 3.1 seconds after restore.
  These are local measurements, not deployment capacity promises.
- Native verification used one bench and bypassed Caddy. Three-bench token
  isolation and Caddy origin/management-route checks are reserved for container
  CI; the test explicitly skips that case outside HTTPS deployment.
- The previous relay spike CI is migrated to lease tokens and isolated snapshots.
  Its workflow then starts the production three-bench overlay for the full Lab
  suite on amd64/arm64. This depends on the deployment lane's `compose.lab.yaml`
  and per-bench secrets. Containers were not run locally (Docker unavailable).

Remaining gates: integrated container CI, independent final review, hosted
staging verification, actual host capacity/load/limits, and owner release
acceptance. Kafka SCRAM identities are separate but topic ACLs remain the
contract's explicit R2 residual risk; credentials do not imply topic isolation.

No npm publication, push, merge, public deployment, or cloud resources were
performed by this implementation lane.
