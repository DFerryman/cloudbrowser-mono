#!/usr/bin/env bash
# Runs once inside the Packer build VM.
set -euxo pipefail

apt-get update
apt-get install -y --no-install-recommends containerd nftables ca-certificates
apt-get purge -y snapd || true

# Agent: one static binary run by systemd.
install -m 0755 /tmp/cloudbrowser-agent /usr/local/bin/cloudbrowser-agent
install -m 0644 /tmp/cloudbrowser/cloudbrowser-agent.service /etc/systemd/system/cloudbrowser-agent.service
install -d -m 0755 /etc/cloudbrowser/nft
install -m 0644 /tmp/cloudbrowser/nft/normal.nft /tmp/cloudbrowser/nft/closed.nft /etc/cloudbrowser/nft/
systemctl enable containerd cloudbrowser-agent

# Firewall baseline: no inbound, IPv4 only, no private or metadata destinations from the browser.
install -m 0644 /tmp/cloudbrowser/nft/normal.nft /etc/nftables.conf
systemctl enable nftables

# The browser image is pre-pulled, so a wake does not wait for a download.
ctr -n cloudbrowser images pull "$BROWSER_IMAGE"
echo "$BROWSER_IMAGE" > /etc/cloudbrowser/browser-image

# No user data or logs in the image.
cloud-init clean --logs
rm -rf /tmp/cloudbrowser /tmp/cloudbrowser-agent
