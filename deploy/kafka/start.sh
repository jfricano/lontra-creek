#!/usr/bin/env bash
# Starts Lontra Creek's broker: Apache Kafka 4.1.2, one KRaft node, in the
# apache/kafka:4.1.2 image (deploy/compose.yaml mounts this script as its entrypoint).
#
# Listeners:
#   CLIENTS   0.0.0.0:9094   SASL_SSL, SCRAM-SHA-512: the gateway and the field station
#   INTERNAL  127.0.0.1:9092 plaintext, loopback only: the broker itself and its health check
#   CONTROLLER 127.0.0.1:9093
#
# The two SCRAM users are created when the storage is formatted, which happens
# once, on a new data volume. To change a password later, use kafka-configs.sh
# --alter --add-config on the INTERNAL listener.
#
# Environment: KAFKA_GATEWAY_USERNAME, KAFKA_GATEWAY_PASSWORD,
# KAFKA_FIELD_STATION_USERNAME, KAFKA_FIELD_STATION_PASSWORD (letters, digits,
# '-' and '_' only, since --add-scram can't quote), KAFKA_HEAP_OPTS, and for
# running outside the image: KAFKA_HOME, KAFKA_DATA_DIR, KAFKA_CERT_DIR,
# KAFKA_ADVERTISED_HOST, KAFKA_CONFIG.
set -euo pipefail

KAFKA_HOME="${KAFKA_HOME:-/opt/kafka}"
DATA="${KAFKA_DATA_DIR:-/var/lib/kafka/data}"
CERTS="${KAFKA_CERT_DIR:-/etc/lontra/kafka}"
ADVERTISED_HOST="${KAFKA_ADVERTISED_HOST:-kafka}"
CONFIG="${KAFKA_CONFIG:-/tmp/lontra-kafka.properties}"
export KAFKA_HEAP_OPTS="${KAFKA_HEAP_OPTS:--Xms3g -Xmx3g -XX:+AlwaysPreTouch}"

for name in KAFKA_GATEWAY_USERNAME KAFKA_GATEWAY_PASSWORD KAFKA_FIELD_STATION_USERNAME KAFKA_FIELD_STATION_PASSWORD; do
  value="${!name:-}"
  if [[ ! "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "$name must be set, using only letters, digits, '-' and '_'." >&2
    exit 2
  fi
done
if [ ! -r "$CERTS/broker-keystore.pem" ]; then
  echo "Cannot read $CERTS/broker-keystore.pem (the broker's key and certificate; see deploy/make-certs.sh)." >&2
  exit 2
fi
if ! mkdir -p "$DATA" || [ ! -w "$DATA" ]; then
  echo "Cannot write the data directory $DATA." >&2
  exit 2
fi

cat > "$CONFIG" <<PROPS
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@127.0.0.1:9093
controller.listener.names=CONTROLLER
listeners=INTERNAL://127.0.0.1:9092,CONTROLLER://127.0.0.1:9093,CLIENTS://0.0.0.0:9094
advertised.listeners=INTERNAL://127.0.0.1:9092,CLIENTS://${ADVERTISED_HOST}:9094
listener.security.protocol.map=INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT,CLIENTS:SASL_SSL
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

if [ ! -f "$DATA/meta.properties" ]; then
  echo "Formatting new storage in $DATA with the gateway's and the field station's SCRAM users."
  "$KAFKA_HOME/bin/kafka-storage.sh" format -t "$("$KAFKA_HOME/bin/kafka-storage.sh" random-uuid)" -c "$CONFIG" \
    --add-scram "SCRAM-SHA-512=[name=${KAFKA_GATEWAY_USERNAME},password=${KAFKA_GATEWAY_PASSWORD}]" \
    --add-scram "SCRAM-SHA-512=[name=${KAFKA_FIELD_STATION_USERNAME},password=${KAFKA_FIELD_STATION_PASSWORD}]"
fi

exec "$KAFKA_HOME/bin/kafka-server-start.sh" "$CONFIG"
