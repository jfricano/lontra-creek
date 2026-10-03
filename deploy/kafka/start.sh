#!/usr/bin/env bash
# Starts Lontra Creek's broker: Apache Kafka 4.1.2, one KRaft node, in the
# apache/kafka:4.1.2 image (deploy/compose.yaml mounts this script as its entrypoint).
#
# Listeners:
#   CLIENTS   0.0.0.0:9094   SASL_SSL, SCRAM-SHA-512: the gateway and the field station
#   INTERNAL  127.0.0.1:9092 plaintext, loopback only: the broker itself and its health check
#   CONTROLLER 127.0.0.1:9093
#   BENCH1…   one SASL_SSL listener per Failure Lab bench, only when
#             KAFKA_BENCH_LISTENERS is set (none by default)
#
# A bench reaches the broker only through its proxy (apps/field-station/src/lab/proxy.ts),
# so cutting the proxy cuts that bench off. Kafka clients reconnect to the address
# the broker advertises, not the one they were given, so each bench has a listener
# of its own, advertised as its proxy's name. KAFKA_BENCH_LISTENERS lists them,
# separated by spaces or commas, as <advertised host>:<port>, bound on the same
# port, or <advertised host>:<port>@<bind port>. For example, in compose:
# "lab-1-kafka:9101 lab-2-kafka:9102 lab-3-kafka:9103". The broker's certificate
# needs each advertised host (deploy/make-certs.sh kafka <dir> lab-1-kafka …).
#
# The SCRAM users are created when the storage is formatted, which happens once, on
# a new data volume. To add or change one later, use kafka-configs.sh --alter
# --add-config on the INTERNAL listener.
#
# Authorization (KAFKA_AUTHORIZATION; LC11-ADR-03, docs/contracts/lab-api.md 10.9):
#   acl      the default here: KRaft's StandardAuthorizer, denying whatever no ACL
#            allows (allow.everyone.if.no.acl.found=false)
#   migrate  the same authorizer and grants, but an operation on a resource that
#            nobody is granted stays open (allow.everyone.if.no.acl.found=true):
#            the first step of the one-time migration of an existing broker
#            (deploy/OPERATIONS.md, Kafka authorization)
#   none     no authorizer: every SCRAM user may read and write every topic
# deploy/compose.yaml passes "none" unless the env file says otherwise, so the
# hosted broker changes only when its operator opts in.
#
# With an authorizer, the INTERNAL and CONTROLLER listeners' principal,
# User:ANONYMOUS, is the only super user: the broker itself and admin tools run
# inside this container on loopback. The SASL_SSL listeners never yield that
# principal, and no SCRAM user may be named ANONYMOUS. Once the broker answers,
# a bootstrap in the background grants each application user the least it needs
# (prefixed patterns), creates each bench's quarantine topic, and then writes
# KAFKA_READY_FILE, which the health check waits for. It is idempotent: on every
# start it lists the ACLs and topics in one call each and adds only what is
# missing. It never removes an ACL. If it fails, it stops the broker.
#
#   User         Topics                                              Groups
#   gateway      Read, Describe: field.*, creek.*                    Read: streamotter-lontra-creek-*
#   field-station Create, Write, Describe: field.*, creek.*, and     Read, Delete: lontra-field-station-read-*
#                each bench's lab-N.field.*, lab-N.creek.*;
#                Read: field.notebooks
#   lab-N        Read, Describe: lab-N.*; Write: lab-N.quarantine    Read, Delete: streamotter-lab-N-*
#
# Environment: KAFKA_GATEWAY_USERNAME, KAFKA_GATEWAY_PASSWORD,
# KAFKA_FIELD_STATION_USERNAME, KAFKA_FIELD_STATION_PASSWORD, and optionally each
# bench's user, KAFKA_LAB_N_USERNAME and KAFKA_LAB_N_PASSWORD for N = 1, 2, 3
# (letters, digits, '-' and '_' only, since --add-scram can't quote), the older
# shared bench user KAFKA_LAB_USERNAME and KAFKA_LAB_PASSWORD (created, but
# granted nothing), KAFKA_AUTHORIZATION, KAFKA_BENCH_LISTENERS,
# KAFKA_HEAP_OPTS, and for running outside the image: KAFKA_HOME, KAFKA_DATA_DIR,
# KAFKA_CERT_DIR, KAFKA_ADVERTISED_HOST, KAFKA_CONFIG, KAFKA_READY_FILE
# (/tmp/lontra-kafka.ready), KAFKA_LISTEN_HOST (0.0.0.0), and the ports
# KAFKA_INTERNAL_PORT (9092), KAFKA_CONTROLLER_PORT (9093), and KAFKA_CLIENT_PORT (9094).
set -euo pipefail

KAFKA_HOME="${KAFKA_HOME:-/opt/kafka}"
DATA="${KAFKA_DATA_DIR:-/var/lib/kafka/data}"
CERTS="${KAFKA_CERT_DIR:-/etc/lontra/kafka}"
ADVERTISED_HOST="${KAFKA_ADVERTISED_HOST:-kafka}"
CONFIG="${KAFKA_CONFIG:-/tmp/lontra-kafka.properties}"
LISTEN_HOST="${KAFKA_LISTEN_HOST:-0.0.0.0}"
INTERNAL_PORT="${KAFKA_INTERNAL_PORT:-9092}"
CONTROLLER_PORT="${KAFKA_CONTROLLER_PORT:-9093}"
CLIENT_PORT="${KAFKA_CLIENT_PORT:-9094}"
READY="${KAFKA_READY_FILE:-/tmp/lontra-kafka.ready}"
AUTHORIZATION="${KAFKA_AUTHORIZATION:-acl}"
export KAFKA_HEAP_OPTS="${KAFKA_HEAP_OPTS:--Xms3g -Xmx3g -XX:+AlwaysPreTouch}"

credential() {
  local value="${!1:-}"
  if [[ ! "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "$1 must be set, using only letters, digits, '-' and '_'." >&2
    exit 2
  fi
  # User:ANONYMOUS is the loopback listeners' principal, and the super user.
  if [[ "$1" == *_USERNAME && "$value" == ANONYMOUS ]]; then
    echo "$1 must not be ANONYMOUS." >&2
    exit 2
  fi
}
case "$AUTHORIZATION" in
  acl|migrate|none) ;;
  *) echo "KAFKA_AUTHORIZATION must be acl, migrate, or none (got $AUTHORIZATION)." >&2; exit 2 ;;
esac
rm -f "$READY"
for name in KAFKA_GATEWAY_USERNAME KAFKA_GATEWAY_PASSWORD KAFKA_FIELD_STATION_USERNAME KAFKA_FIELD_STATION_PASSWORD; do
  credential "$name"
done
scram=(
  --add-scram "SCRAM-SHA-512=[name=${KAFKA_GATEWAY_USERNAME},password=${KAFKA_GATEWAY_PASSWORD}]"
  --add-scram "SCRAM-SHA-512=[name=${KAFKA_FIELD_STATION_USERNAME},password=${KAFKA_FIELD_STATION_PASSWORD}]"
)
if [ -n "${KAFKA_LAB_USERNAME:-}${KAFKA_LAB_PASSWORD:-}" ]; then
  credential KAFKA_LAB_USERNAME
  credential KAFKA_LAB_PASSWORD
  scram+=(--add-scram "SCRAM-SHA-512=[name=${KAFKA_LAB_USERNAME},password=${KAFKA_LAB_PASSWORD}]")
fi
# Independent identities for the production Lab; existing spike user remains optional.
bench_numbers=()
bench_users=()
for number in 1 2 3; do
  username="KAFKA_LAB_${number}_USERNAME"
  password="KAFKA_LAB_${number}_PASSWORD"
  if [ -n "${!username:-}${!password:-}" ]; then
    credential "$username"
    credential "$password"
    scram+=(--add-scram "SCRAM-SHA-512=[name=${!username},password=${!password}]")
    bench_numbers+=("$number")
    bench_users+=("${!username}")
  fi
done
for port in "$INTERNAL_PORT" "$CONTROLLER_PORT" "$CLIENT_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "Kafka ports must be numbers (got $port)." >&2; exit 2; }
done
if [ ! -r "$CERTS/broker-keystore.pem" ]; then
  echo "Cannot read $CERTS/broker-keystore.pem (the broker's key and certificate; see deploy/make-certs.sh)." >&2
  exit 2
fi
if ! mkdir -p "$DATA" || [ ! -w "$DATA" ]; then
  echo "Cannot write the data directory $DATA." >&2
  exit 2
fi

# One SASL_SSL listener per bench, advertised as that bench's proxy.
listeners="INTERNAL://127.0.0.1:${INTERNAL_PORT},CONTROLLER://127.0.0.1:${CONTROLLER_PORT},CLIENTS://${LISTEN_HOST}:${CLIENT_PORT}"
advertised="INTERNAL://127.0.0.1:${INTERNAL_PORT},CLIENTS://${ADVERTISED_HOST}:${CLIENT_PORT}"
protocols="INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT,CLIENTS:SASL_SSL"
bench_properties=""
bench=0
IFS=', ' read -r -a entries <<< "${KAFKA_BENCH_LISTENERS:-}"
for entry in ${entries[@]+"${entries[@]}"}; do
  if [[ ! "$entry" =~ ^([A-Za-z0-9][A-Za-z0-9.-]*):([0-9]+)(@([0-9]+))?$ ]]; then
    echo "KAFKA_BENCH_LISTENERS: expected <host>:<port> or <host>:<port>@<bind port>, got $entry." >&2
    exit 2
  fi
  bench=$((bench + 1))
  name="BENCH${bench}"
  listeners="${listeners},${name}://${LISTEN_HOST}:${BASH_REMATCH[4]:-${BASH_REMATCH[2]}}"
  advertised="${advertised},${name}://${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
  protocols="${protocols},${name}:SASL_SSL"
  bench_properties+="listener.name.bench${bench}.sasl.enabled.mechanisms=SCRAM-SHA-512
listener.name.bench${bench}.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required;
"
done

cat > "$CONFIG" <<PROPS
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@127.0.0.1:${CONTROLLER_PORT}
controller.listener.names=CONTROLLER
listeners=${listeners}
advertised.listeners=${advertised}
listener.security.protocol.map=${protocols}
inter.broker.listener.name=INTERNAL
log.dirs=${DATA}
num.partitions=3
auto.create.topics.enable=false
offsets.topic.replication.factor=1
offsets.topic.num.partitions=3
transaction.state.log.replication.factor=1
transaction.state.log.min.isr=1
share.coordinator.state.topic.replication.factor=1
share.coordinator.state.topic.min.isr=1
group.initial.rebalance.delay.ms=0
ssl.keystore.type=PEM
ssl.keystore.location=${CERTS}/broker-keystore.pem
ssl.client.auth=none
sasl.enabled.mechanisms=SCRAM-SHA-512
listener.name.clients.sasl.enabled.mechanisms=SCRAM-SHA-512
listener.name.clients.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required;
PROPS
printf '%s' "$bench_properties" >> "$CONFIG"
if [ "$AUTHORIZATION" != none ]; then
  cat >> "$CONFIG" <<PROPS
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
allow.everyone.if.no.acl.found=$([ "$AUTHORIZATION" = migrate ] && echo true || echo false)
super.users=User:ANONYMOUS
PROPS
fi

if [ ! -f "$DATA/meta.properties" ]; then
  if [ ${#scram[@]} -gt 4 ]; then
    echo "Formatting new storage in $DATA with the gateway's, the field station's, and the benches' SCRAM users."
  else
    echo "Formatting new storage in $DATA with the gateway's and the field station's SCRAM users."
  fi
  "$KAFKA_HOME/bin/kafka-storage.sh" format -t "$("$KAFKA_HOME/bin/kafka-storage.sh" random-uuid)" -c "$CONFIG" "${scram[@]}"
fi

if [ "$AUTHORIZATION" = none ]; then
  touch "$READY"
  exec "$KAFKA_HOME/bin/kafka-server-start.sh" "$CONFIG"
fi

# Each grant: <principal>;<pattern type>;<operations>;<resources>, where resources
# are <type>:<name> separated by spaces. One grant is one kafka-acls.sh call.
gateway="User:${KAFKA_GATEWAY_USERNAME}"
station="User:${KAFKA_FIELD_STATION_USERNAME}"
station_topics="topic:field. topic:creek."
for number in ${bench_numbers[@]+"${bench_numbers[@]}"}; do
  station_topics+=" topic:lab-${number}.field. topic:lab-${number}.creek."
done
grants=(
  "$gateway;prefixed;Read Describe;topic:field. topic:creek. group:streamotter-lontra-creek-"
  "$station;prefixed;Create Write Describe;$station_topics"
  "$station;literal;Read;topic:field.notebooks"
  "$station;prefixed;Read Delete;group:lontra-field-station-read-"
)
quarantine=()
for index in ${bench_numbers[@]+"${!bench_numbers[@]}"}; do
  number="${bench_numbers[$index]}"
  user="User:${bench_users[$index]}"
  grants+=(
    "$user;prefixed;Read Describe;topic:lab-${number}."
    "$user;literal;Write;topic:lab-${number}.quarantine"
    "$user;prefixed;Read Delete;group:streamotter-lab-${number}-"
  )
  quarantine+=("lab-${number}.quarantine")
done
if [ -n "${KAFKA_LAB_USERNAME:-}" ]; then
  echo "KAFKA_LAB_USERNAME (${KAFKA_LAB_USERNAME}) is granted nothing; benches use KAFKA_LAB_N_USERNAME."
fi

# The command-line tools get a small heap of their own, not the broker's.
tool() {
  KAFKA_HEAP_OPTS="-Xms32m -Xmx256m" "$KAFKA_HOME/bin/$1" --bootstrap-server "127.0.0.1:${INTERNAL_PORT}" "${@:2}"
}

# The ACLs that exist, one "<type>:<name>;<pattern type>;<principal>;<operation>" per line.
existing_acls() {
  tool kafka-acls.sh --list | awk '
    /^Current ACLs for resource/ {
      match($0, /resourceType=[A-Z_]+/); type = tolower(substr($0, RSTART + 13, RLENGTH - 13))
      match($0, /name=[^,]+/); name = substr($0, RSTART + 5, RLENGTH - 5)
      match($0, /patternType=[A-Z]+/); pattern = tolower(substr($0, RSTART + 12, RLENGTH - 12))
      next
    }
    /principal=.*permissionType=ALLOW/ {
      match($0, /principal=[^,]+/); principal = substr($0, RSTART + 10, RLENGTH - 10)
      match($0, /operation=[A-Z_]+/); operation = tolower(substr($0, RSTART + 10, RLENGTH - 10))
      print type ":" name ";" pattern ";" principal ";" operation
    }'
}

bootstrap() {
  local acls topics grant principal pattern operations resources resource operation missing args added=0
  # Called as a condition, where set -e doesn't apply: every step checks its own status.
  acls="$(existing_acls)" || return 1
  for grant in "${grants[@]}"; do
    IFS=';' read -r principal pattern operations resources <<< "$grant"
    missing=0
    args=(--add --allow-principal "$principal" --resource-pattern-type "$pattern")
    for operation in $operations; do args+=(--operation "$operation"); done
    for resource in $resources; do
      args+=("--${resource%%:*}" "${resource#*:}")
      for operation in $operations; do
        grep -Fxq "${resource};${pattern};${principal};${operation,,}" <<< "$acls" || missing=1
      done
    done
    if [ "$missing" = 1 ]; then
      tool kafka-acls.sh "${args[@]}" > /dev/null || return 1
      added=$((added + 1))
    fi
  done
  topics="$(tool kafka-topics.sh --list)" || return 1
  for topic in ${quarantine[@]+"${quarantine[@]}"}; do
    grep -Fxq "$topic" <<< "$topics" && continue
    # Evidence for V1.1's quarantine exercises: small, and gone within the hour.
    tool kafka-topics.sh --create --if-not-exists --topic "$topic" --partitions 1 --replication-factor 1 \
      --config cleanup.policy=delete --config retention.ms=3600000 --config retention.bytes=8388608 \
      --config segment.bytes=1048576 --config segment.ms=600000 > /dev/null || return 1
    echo "Created $topic."
  done
  echo "Kafka authorization ($AUTHORIZATION): ${#grants[@]} grants, $added added; ${#quarantine[@]} quarantine topics."
}

(
  for _ in $(seq 1 120); do
    (exec 3<> "/dev/tcp/127.0.0.1/${INTERNAL_PORT}") 2> /dev/null && break
    sleep 1
  done
  for attempt in 1 2 3 4 5; do
    if bootstrap; then
      touch "$READY"
      exit 0
    fi
    echo "Kafka authorization bootstrap failed (attempt $attempt); retrying." >&2
    sleep 3
  done
  echo "Kafka authorization bootstrap failed; stopping the broker." >&2
  kill -TERM $$
) &

exec "$KAFKA_HOME/bin/kafka-server-start.sh" "$CONFIG"
