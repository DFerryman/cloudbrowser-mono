#!/usr/bin/env bash
# Packer golden image (later): the same layout the first-boot script (packages/executors/src/aws/
# user-data.ts) builds on a stock image, pre-installed so a new VM does not install anything.
# Runs once inside the Packer build VM. No user data or secrets are baked in.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends docker.io nftables ca-certificates curl
apt-get purge -y snapd || true
install -d /etc/docker
echo '{ "iptables": false, "ip6tables": false, "bridge": "none", "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' >/etc/docker/daemon.json
systemctl restart docker

install -m 0755 /tmp/cloudbrowser-agent /usr/local/bin/cloudbrowser-agent
install -d /usr/local/lib/cloudbrowser /etc/cloudbrowser/nft
install -m 0755 /tmp/cloudbrowser/bin/* /usr/local/lib/cloudbrowser/
install -m 0644 /tmp/cloudbrowser/systemd/*.service /etc/systemd/system/

# The browser image is pre-pulled, so a wake does not wait for a download.
docker pull "$BROWSER_IMAGE"
uid=$(docker run --rm --entrypoint id "$BROWSER_IMAGE" -u neko)
echo "$uid" >/etc/cloudbrowser/browser-uid
for f in normal closed; do sed "s/@BROWSER_UID@/$uid/g" "/tmp/cloudbrowser/nft/$f.nft.in" >"/etc/cloudbrowser/nft/$f.nft"; done
cp /etc/cloudbrowser/nft/normal.nft /etc/nftables.conf
systemctl enable nftables
# The units are enabled by the VM's first boot, once its user data (agent.json) exists.

cloud-init clean --logs
rm -rf /tmp/cloudbrowser /tmp/cloudbrowser-agent
