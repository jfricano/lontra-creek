#!/usr/bin/env bash
# Run as root on an approved Ubuntu 24.04 host from an audited checkout.
set -euo pipefail
umask 077
[ "$EUID" -eq 0 ] || { echo 'Run as root.' >&2; exit 2; }
[ "$#" -eq 4 ] || { echo 'Usage: setup.sh origin-cert origin-key deploy-ed25519.pub FIELD_EPOCH' >&2; exit 2; }
cert=$(realpath "$1"); key=$(realpath "$2"); pub=$(realpath "$3"); epoch=$4
[[ "$epoch" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || exit 2
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo 'Requires Ubuntu 24.04.' >&2; exit 2; }
openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null
openssl x509 -in "$cert" -noout -checkhost demo.streamotter.dev >/dev/null
cmp <(openssl x509 -in "$cert" -pubkey -noout) <(openssl pkey -in "$key" -pubout) || { echo 'Certificate/key mismatch.' >&2; exit 2; }
public_key=$(cat "$pub")
[[ "$public_key" != *$'\n'* && "$public_key" != *$'\r'* ]] || { echo 'Public key must be one line.' >&2; exit 2; }
[[ $(wc -l < "$pub") -eq 1 ]] && [[ "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+([[:space:]].*)?$ ]] || { echo 'One plain ed25519 public key required.' >&2; exit 2; }
ssh-keygen -lf "$pub" >/dev/null
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y openssl iptables iptables-persistent
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y docker.io docker-compose-v2
fi
systemctl enable --now docker
# Preserve SSH and existing rules; Docker publishes 443 via FORWARD, not INPUT.
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
netfilter-persistent save
root=/srv/lontra
src=$(cd "$(dirname "$0")" && pwd)
install -d -m 700 "$root" "$root/secrets" "$root/secrets/origin" "$root/releases"
install -d -m 755 "$root/config" "$root/config/kafka"
install -m 644 "$src/compose.yaml" "$root/config/compose.yaml"
install -m 644 "$src/compose.lab.yaml" "$root/config/compose.lab.yaml"
install -m 644 "$src/operations/checkpoint.mjs" "$root/config/checkpoint.mjs"
install -m 644 "$src/Caddyfile" "$root/config/Caddyfile"
install -m 755 "$src/kafka/start.sh" "$root/config/kafka/start.sh"
"$src/make-secrets.sh" "$root/stack.env"
if ! grep -q '^FIELD_EPOCH=' "$root/stack.env"; then
  printf 'FIELD_EPOCH=%s\nLONTRA_SECRETS=%s/secrets\n' "$epoch" "$root" >> "$root/stack.env"
fi
"$src/make-certs.sh" kafka "$root/secrets/kafka" lab-1-kafka lab-2-kafka lab-3-kafka
# Container UIDs need directory traversal and the mounted files. The root-only
# /srv/lontra ancestor prevents host users from traversing to any secret.
chmod 755 "$root/secrets/kafka" "$root/secrets/origin"
install -m 644 "$cert" "$root/secrets/origin/cert.pem"
install -m 644 "$key" "$root/secrets/origin/key.pem"
chmod 600 "$root/stack.env"
install -m 755 "$src/operations/deploy.sh" /usr/local/sbin/lontra-deploy
install -m 755 "$src/operations/checkpoint.sh" /usr/local/sbin/lontra-checkpoint
install -m 755 "$src/operations/health.sh" /usr/local/sbin/lontra-health
install -m 644 "$src"/operations/systemd/* /etc/systemd/system/
systemctl daemon-reload
# Installed, not enabled: operator must first rehearse restore and notification routing.
install -m 755 "$src/operations/ssh-command.sh" /usr/local/sbin/lontra-ssh-command
id lontra-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash lontra-deploy
# Root owns authorized_keys and the home, so this credential cannot replace its restriction.
chown root:root /home/lontra-deploy
chmod 755 /home/lontra-deploy
install -d -o root -g root -m 755 /home/lontra-deploy/.ssh
printf 'restrict,command="/usr/local/sbin/lontra-ssh-command" %s\n' "$public_key" > /home/lontra-deploy/.ssh/authorized_keys
chmod 644 /home/lontra-deploy/.ssh/authorized_keys
printf 'lontra-deploy ALL=(root) NOPASSWD: /usr/local/sbin/lontra-deploy\n' > /etc/sudoers.d/lontra-deploy
chmod 440 /etc/sudoers.d/lontra-deploy
visudo -cf /etc/sudoers.d/lontra-deploy
printf 'Setup complete. No stack started. Epoch and existing secrets preserved.\n'
