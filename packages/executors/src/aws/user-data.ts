/**
 * First-boot script for a browser VM on stock Ubuntu 24.04 (cloud-init runs it once per VM).
 * It installs Docker and nftables, takes the agent binary and the VM files (systemd units, scripts,
 * firewall rules) out of the agent image, pulls the browser image and starts everything. Later
 * boots (every wake) only run the systemd units. A pre-built golden image (images/vm, Packer)
 * replaces the install part later; the units are the same.
 *
 * The only secret is the single-use bootstrap token, which the agent swaps for its credential on
 * first connect.
 */
export interface BootstrapInput {
  instanceId: string;
  gatewayUrl: string;
  bootstrapToken: string;
  /** e.g. https://app.example.com: the agent's in-Chrome IP check uses `${appUrl}/api/echo/ip`. */
  appUrl: string;
  agentImage: string;
  browserImage: string;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function bootstrapScript(input: BootstrapInput): string {
  const agentJson = JSON.stringify({ instanceId: input.instanceId, gatewayUrl: input.gatewayUrl, bootstrapToken: input.bootstrapToken });
  const echo = `${input.appUrl.replace(/\/$/, '')}/api/echo/ip`;
  return `#!/bin/bash
# CloudBrowser first boot. Also on the serial console (EC2: Actions → Monitor → Get system log).
set -euo pipefail
exec > >(tee -a /var/log/cloudbrowser-bootstrap.log | sed 's/^/cloudbrowser: /' >/dev/console) 2>&1
echo "bootstrap start $(date -Is)"

install -d -m 0700 /etc/cloudbrowser /var/lib/cloudbrowser
umask 077
printf '%s\\n' ${shellQuote(agentJson)} >/etc/cloudbrowser/agent.json
cat >/etc/cloudbrowser/cloudbrowser.env <<'ENV'
AGENT_IMAGE=${input.agentImage}
BROWSER_IMAGE=${input.browserImage}
ECHO_URL=${echo}
ENV
umask 022

export DEBIAN_FRONTEND=noninteractive
for i in 1 2 3 4 5; do apt-get update -q && apt-get install -y -q --no-install-recommends docker.io nftables && break; sleep 15; done
# The browser shares the host network (WebRTC advertises the static IP); Docker must not touch
# the firewall or create a bridge.
install -d /etc/docker
cat >/etc/docker/daemon.json <<'JSON'
{ "iptables": false, "ip6tables": false, "bridge": "none", "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker

. /etc/cloudbrowser/cloudbrowser.env
for i in 1 2 3 4 5 6; do docker pull "$AGENT_IMAGE" && docker pull "$BROWSER_IMAGE" && break; sleep 20; done

# Agent binary and VM files ship in the agent image.
cid=$(docker create "$AGENT_IMAGE")
docker cp "$cid:/cloudbrowser-agent" /usr/local/bin/cloudbrowser-agent
rm -rf /tmp/cbvm && docker cp "$cid:/vm" /tmp/cbvm
docker rm "$cid" >/dev/null
chmod 0755 /usr/local/bin/cloudbrowser-agent
install -d /usr/local/lib/cloudbrowser /etc/cloudbrowser/nft
install -m 0755 /tmp/cbvm/bin/* /usr/local/lib/cloudbrowser/
install -m 0644 /tmp/cbvm/systemd/*.service /etc/systemd/system/

# Firewall rules apply to the browser's user; read its uid from the image.
neko_uid=$(docker run --rm --entrypoint id "$BROWSER_IMAGE" -u neko)
echo "$neko_uid" >/etc/cloudbrowser/browser-uid
for f in normal closed; do sed "s/@BROWSER_UID@/$neko_uid/g" "/tmp/cbvm/nft/$f.nft.in" >"/etc/cloudbrowser/nft/$f.nft"; done
cp /etc/cloudbrowser/nft/normal.nft /etc/nftables.conf

# neko's admin password: only the agent uses it, to open viewer sessions on the loopback interface.
[ -s /etc/cloudbrowser/neko-password ] || (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n' >/etc/cloudbrowser/neko-password)
rm -rf /tmp/cbvm

systemctl daemon-reload
systemctl enable nftables cloudbrowser-data cloudbrowser-browser cloudbrowser-agent
systemctl restart nftables
systemctl start cloudbrowser-data cloudbrowser-browser cloudbrowser-agent
echo "bootstrap done $(date -Is)"
`;
}
