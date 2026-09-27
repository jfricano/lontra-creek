#!/usr/bin/env bash
# Makes the TLS material the stack needs, with openssl.
#
#   deploy/make-certs.sh kafka <dir> [<host>...]
#       A private CA for the broker (ca.pem, ca-key.pem) and the broker's key and
#       certificate (broker-keystore.pem, PEM with a PKCS#8 key) for the host names
#       "kafka" and "localhost", 127.0.0.1, and each <host> given: the Failure Lab's
#       proxy names, such as lab-1-kafka, which the broker advertises to each bench.
#       Clients trust ca.pem. Existing files are kept; if the broker's certificate
#       lacks a <host>, only it is reissued, from the same CA, so clients keep
#       trusting ca.pem (restart the broker to use it).
#
#   deploy/make-certs.sh test-origin <dir> <host>
#       For CI only: a throwaway CA (ca.pem) and a certificate for <host>
#       (cert.pem, key.pem) standing in for the Cloudflare origin certificate
#       Caddy uses in production.
set -euo pipefail

usage() {
  echo "Usage: $0 kafka <dir> [<host>...] | $0 test-origin <dir> <host>" >&2
  exit 2
}

new_ca() {
  # new_ca <dir> <ca-name>
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$2" \
    -keyout "$1/ca-key.pem" -out "$1/ca.pem" 2>/dev/null
}

sign() {
  # sign <dir> <leaf-name> <subject CN> <subjectAltName>, with the CA in <dir>
  local dir="$1" leaf="$2" cn="$3" san="$4"
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$cn" \
    -keyout "$dir/$leaf-key.rsa.pem" -out "$dir/$leaf.csr" 2>/dev/null
  printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$san" > "$dir/$leaf.ext"
  openssl x509 -req -in "$dir/$leaf.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca-key.pem" -CAcreateserial \
    -days 825 -extfile "$dir/$leaf.ext" -out "$dir/$leaf.pem" 2>/dev/null
  openssl pkcs8 -topk8 -nocrypt -in "$dir/$leaf-key.rsa.pem" -out "$dir/$leaf-key.pem"
  rm -f "$dir/$leaf-key.rsa.pem" "$dir/$leaf.csr" "$dir/$leaf.ext" "$dir/ca.srl"
}

names() {
  # The subjectAltName entries of the certificate in a PEM file, one per line.
  openssl x509 -in "$1" -noout -text | awk '/Subject Alternative Name/ { getline; print }' | tr ',' '\n' | sed 's/^ *//'
}

[ $# -ge 2 ] || usage
command="$1"
dir="$2"
mkdir -p "$dir"

case "$command" in
  kafka)
    shift 2
    san="DNS:kafka,DNS:localhost,IP:127.0.0.1"
    for host in "$@"; do
      [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "Not a host name: $host" >&2; exit 2; }
      san="$san,DNS:$host"
    done
    if [ -f "$dir/broker-keystore.pem" ]; then
      missing=()
      for host in "$@"; do
        names "$dir/broker-keystore.pem" | grep -qxF "DNS:$host" || missing+=("$host")
      done
      if [ ${#missing[@]} -eq 0 ]; then
        echo "Kafka certificates already exist in $dir; keeping them."
        exit 0
      fi
      if [ ! -f "$dir/ca-key.pem" ]; then
        echo "The broker certificate in $dir lacks ${missing[*]}, and the CA key to reissue it is missing." >&2
        exit 2
      fi
      echo "Reissuing the broker certificate in $dir to add ${missing[*]}; the CA is kept."
    else
      new_ca "$dir" "Lontra Creek Kafka CA"
    fi
    sign "$dir" broker kafka "$san"
    cat "$dir/broker-key.pem" "$dir/broker.pem" > "$dir/broker-keystore.pem"
    rm -f "$dir/broker-key.pem" "$dir/broker.pem"
    chmod 600 "$dir/ca-key.pem"
    chmod 644 "$dir/ca.pem" "$dir/broker-keystore.pem"
    echo "Wrote the Kafka CA and broker certificate to $dir."
    ;;
  test-origin)
    [ $# -eq 3 ] || usage
    new_ca "$dir" "Lontra Creek test origin CA"
    sign "$dir" cert "$3" "DNS:$3"
    mv "$dir/cert-key.pem" "$dir/key.pem"
    chmod 644 "$dir/ca.pem" "$dir/cert.pem" "$dir/key.pem"
    echo "Wrote a test CA and a certificate for $3 to $dir."
    ;;
  *)
    usage
    ;;
esac
