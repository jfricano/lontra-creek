#!/usr/bin/env bash
# Makes the TLS material the stack needs, with openssl.
#
#   deploy/make-certs.sh kafka <dir>
#       A private CA for the broker (ca.pem, ca-key.pem) and the broker's key and
#       certificate for the host name "kafka" (broker-keystore.pem, PEM with a
#       PKCS#8 key). Clients trust ca.pem. Existing files are kept.
#
#   deploy/make-certs.sh test-origin <dir> <host>
#       For CI only: a throwaway CA (ca.pem) and a certificate for <host>
#       (cert.pem, key.pem) standing in for the Cloudflare origin certificate
#       Caddy uses in production.
set -euo pipefail

usage() {
  echo "Usage: $0 kafka <dir> | $0 test-origin <dir> <host>" >&2
  exit 2
}

issue() {
  # issue <dir> <ca-name> <leaf-name> <subject CN> <subjectAltName>
  local dir="$1" ca="$2" leaf="$3" cn="$4" san="$5"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$ca" \
    -keyout "$dir/ca-key.pem" -out "$dir/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$cn" \
    -keyout "$dir/$leaf-key.rsa.pem" -out "$dir/$leaf.csr" 2>/dev/null
  printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$san" > "$dir/$leaf.ext"
  openssl x509 -req -in "$dir/$leaf.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca-key.pem" -CAcreateserial \
    -days 825 -extfile "$dir/$leaf.ext" -out "$dir/$leaf.pem" 2>/dev/null
  openssl pkcs8 -topk8 -nocrypt -in "$dir/$leaf-key.rsa.pem" -out "$dir/$leaf-key.pem"
  rm -f "$dir/$leaf-key.rsa.pem" "$dir/$leaf.csr" "$dir/$leaf.ext" "$dir/ca.srl"
}

[ $# -ge 2 ] || usage
command="$1"
dir="$2"
mkdir -p "$dir"

case "$command" in
  kafka)
    if [ -f "$dir/broker-keystore.pem" ]; then
      echo "Kafka certificates already exist in $dir; keeping them."
      exit 0
    fi
    issue "$dir" "Lontra Creek Kafka CA" broker kafka "DNS:kafka,DNS:localhost,IP:127.0.0.1"
    cat "$dir/broker-key.pem" "$dir/broker.pem" > "$dir/broker-keystore.pem"
    rm -f "$dir/broker-key.pem" "$dir/broker.pem"
    chmod 600 "$dir/ca-key.pem"
    chmod 644 "$dir/ca.pem" "$dir/broker-keystore.pem"
    echo "Wrote the Kafka CA and broker certificate to $dir."
    ;;
  test-origin)
    [ $# -eq 3 ] || usage
    issue "$dir" "Lontra Creek test origin CA" cert "$3" "DNS:$3"
    mv "$dir/cert-key.pem" "$dir/key.pem"
    chmod 644 "$dir/ca.pem" "$dir/cert.pem" "$dir/key.pem"
    echo "Wrote a test CA and a certificate for $3 to $dir."
    ;;
  *)
    usage
    ;;
esac
