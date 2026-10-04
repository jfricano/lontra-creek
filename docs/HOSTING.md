# Hosting checklist

How streamotter.dev and the Lontra Creek demo get onto the internet, on free tiers, per [PLAN.md](PLAN.md#architecture-and-hosting). The engineering steps are in [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md). Steps marked **Owner** need the owner's accounts, payment details, or approval. Section 4 is code in this repository.

> **October 4, 2026: superseded for the hosted demo.** This checklist was written for a dedicated Oracle Cloud VM in the standalone `/srv/lontra` layout. The hosted demo is to run on a shared ARM host beside other apps, behind devops's shared TLS edge, under `/srv/apps/lontra` with `/etc/apps/lontra/lontra.env`, activated with devops's shared-host procedure; the instance, its ports, the origin certificate and the deploy SSH key below are not part of that path. The one-time GitHub, Cloudflare and shared-host configuration is in the [rollout plan](releases/0.2.0-rc.1/ROLLOUT_PLAN.md) (Configure first), and the adapter in [SHARED_HOST_READINESS.md](SHARED_HOST_READINESS.md). The rest of this file is kept as the record of the standalone plan.

## 1. Accounts (Owner, now)

- [ ] **Cloudflare account** (free plan) at dash.cloudflare.com, with two-factor authentication on.
- [ ] **Register `streamotter.dev`** through Cloudflare Registrar. `.dev` is HTTPS-only by browser rule, which Cloudflare handles.
- [ ] **Oracle Cloud account** at oracle.com/cloud/free, with two-factor authentication on. Oracle verifies a card at signup. The **home region can't be changed later** and decides where the demo runs: pick one near most visitors. Ampere A1 capacity is sometimes short in busy regions; if instance creation later says "out of capacity", retry later or try another availability domain.
- [ ] **Upgrade the Oracle account to Pay As You Go** (Billing and Cost Management, Upgrade and Manage Payment). Always Free resources stay free.
- [ ] **Budget alarm:** Billing and Cost Management, Budgets, Create Budget: the root compartment, $1 a month, and an alert rule on *actual* spend at 100% that emails you. Any charge means something outside Always Free exists. Alarms notify; they don't stop spending.
- [ ] **GitHub repository** `jfricano/lontra-creek`: decide public or private. Nothing is pushed without your go-ahead.

## 2. The demo host (Owner, with the values below)

- [ ] **SSH key** for the server: `ssh-keygen -t ed25519 -f ~/.ssh/lontra-creek -C lontra-creek`. Keep the private key; the public key (`~/.ssh/lontra-creek.pub`) goes to Oracle.
- [ ] **Create the instance:** Compute, Instances, Create instance.
  - Image: Canonical Ubuntu 24.04, aarch64.
  - Shape: VM.Standard.A1.Flex, **2 OCPUs, 12 GB** (the whole Always Free A1 allowance). Check that the console labels it "Always Free-eligible".
  - Boot volume: 100 GB (Always Free covers 200 GB in total).
  - Networking: a new VCN with a public subnet, and a public IPv4 address.
  - SSH: paste the public key.
- [ ] **Open ports** in the subnet's security list: TCP 443 from anywhere (Cloudflare connects here), and TCP 22 from your own IP only. The server's own firewall is opened by the setup script.
- [ ] Record the instance's public IP for the deploy configuration. Never share the private key.

## 3. Domain and TLS (Owner, with the values below)

- [ ] Cloudflare DNS: `demo.streamotter.dev`, an `A` record to the instance IP, **proxied** (orange cloud), so visitors never see the server's address.
- [ ] Cloudflare SSL/TLS mode: **Full (strict)**.
- [ ] Cloudflare Origin Server certificate for `streamotter.dev` and `*.streamotter.dev`; install it on the server as the setup script describes.
- [ ] A Cloudflare API token limited to deploying the static site, stored as a GitHub Actions secret, and the Cloudflare account ID, stored as a GitHub Actions variable.
- [ ] A deploy SSH key for GitHub Actions, separate from your own (`ssh-keygen -t ed25519 -f ~/.ssh/lontra-creek-deploy -C lontra-creek-deploy`): the public key goes on the server (the setup script restricts it to deploying), and the private key is stored as a secret of a GitHub `production` environment that requires your approval.
- [ ] Decide whether `images.yml` publishes the stack's image to GitHub's registry (`ghcr.io/jfricano/lontra-creek`) on merges to `main`: public, with a retention policy for old images. See [TEAM_PLAN.md](TEAM_PLAN.md#8-the-owner).

## 4. What this repository builds

- [x] Production StreamOtter configuration: Kafka over TLS with SCRAM-SHA-512, allowed origin `https://streamotter.dev`.
- [x] The field station's production runner: the simulation on the wall clock, write then publish to Kafka, hourly checkpoints, the site API.
- [x] Notebooks on a compacted topic (expired without tombstones).
- [ ] The Failure Lab: three benches, leases, the relay-cut proxy, the slow client, the redacted trace feed.
- [x] `compose.yaml`: Caddy, Kafka 4.1.2, the gateway from npm, the field station; the broker with a fixed, pre-touched 3 GB heap (see PLAN.md, Budget protection). Tested in CI on amd64 and arm64.
- [ ] The Failure Lab's benches in `compose.yaml`.
- [ ] A server setup script: Docker, the firewall, directories, secrets generated on the server.
- [ ] GitHub Actions: build arm64 images; deploy to the server over SSH; deploy the static site to Cloudflare.
- [ ] Health checks, a memory alert, backups of checkpoints, and a documented rollback.

## 5. Before launch (both)

- [ ] Staging passes the launch criteria in [PLAN.md](PLAN.md#launch-criteria), including the Failure Lab and the unavailable state.
- [ ] Record the measured operating limits and the operator in PLAN.md.
- [ ] Owner's go-ahead, then DNS for the apex, then smoke-test every public link.
