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
# Environment: KAFKA_GATEWAY_USERNAME, KAFKA_GATEWAY_PASSWORD,
# KAFKA_FIELD_STATION_USERNAME, KAFKA_FIELD_STATION_PASSWORD, and optionally the
# benches' user, KAFKA_LAB_USERNAME and KAFKA_LAB_PASSWORD (letters, digits, '-'
# and '_' only, since --add-scram can't quote), KAFKA_BENCH_LISTENERS,
# KAFKA_HEAP_OPTS, and for running outside the image: KAFKA_HOME, KAFKA_DATA_DIR,
# KAFKA_CERT_DIR, KAFKA_ADVERTISED_HOST, KAFKA_CONFIG, KAFKA_LISTEN_HOST (0.0.0.0),
# and the ports KAFKA_INTERNAL_PORT (9092), KAFKA_CONTROLLER_PORT (9093), and
# KAFKA_CLIENT_PORT (9094).
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
export KAFKA_HEAP_OPTS="${KAFKA_HEAP_OPTS:--Xms3g -Xmx3g -XX:+AlwaysPreTouch}"

credential() {
  local value="${!1:-}"
  if [[ ! "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "$1 must be set, using only letters, digits, '-' and '_'." >&2
    exit 2
  fi
}
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
for number in 1 2 3; do
  username="KAFKA_LAB_${number}_USERNAME"
  password="KAFKA_LAB_${number}_PASSWORD"
  if [ -n "${!username:-}${!password:-}" ]; then
    credential "$username"
    credential "$password"
    scram+=(--add-scram "SCRAM-SHA-512=[name=${!username},password=${!password}]")
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

if [ ! -f "$DATA/meta.properties" ]; then
  if [ ${#scram[@]} -gt 4 ]; then
    echo "Formatting new storage in $DATA with the gateway's, the field station's, and the benches' SCRAM users."
  else
    echo "Formatting new storage in $DATA with the gateway's and the field station's SCRAM users."
  fi
  "$KAFKA_HOME/bin/kafka-storage.sh" format -t "$("$KAFKA_HOME/bin/kafka-storage.sh" random-uuid)" -c "$CONFIG" "${scram[@]}"
fi

exec "$KAFKA_HOME/bin/kafka-server-start.sh" "$CONFIG"
