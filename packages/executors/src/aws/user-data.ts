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
  /** IANA timezone for the browser (e.g. Asia/Tokyo); UTC when absent or malformed. */
  timezone?: string;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function bootstrapScript(input: BootstrapInput): string {
  const agentJson = JSON.stringify({ instanceId: input.instanceId, gatewayUrl: input.gatewayUrl, bootstrapToken: input.bootstrapToken });
  const echo = `${input.appUrl.replace(/\/$/, '')}/api/echo/ip`;
  // Written into an env file: only a plain zone name may pass, never a newline or a quote.
  const timezone = input.timezone && /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(input.timezone) ? input.timezone : 'UTC';
  return `#!/bin/bash
# Nevazu first boot. Also on the serial console (EC2: Actions → Monitor → Get system log).
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
BROWSER_TZ=${timezone}
ENV
umask 022

# The VM has 4 GB, enough for the browser; a small swap file absorbs the odd spike so the kernel
# does not have to kill Chrome. Swappiness 10: only used under memory pressure.
if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && echo '/swapfile none swap sw 0 0' >>/etc/fstab; fi
swapon /swapfile 2>/dev/null || true
echo 'vm.swappiness=10' >/etc/sysctl.d/90-cloudbrowser.conf && sysctl -q -p /etc/sysctl.d/90-cloudbrowser.conf

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
# Older agent images ship a unit that inherits the browser image's non-root user, preventing
# supervisor from starting. Only supervisor needs root; its Chrome and neko programs use neko.
# The corrected unit already contains --user root, so this compatibility fix is idempotent.
sed -i 's/--name browser --network/--name browser --user root --network/' /etc/systemd/system/cloudbrowser-browser.service

# Older browser images inherit policies that disable CDP and isolated browser contexts. Keep
# all other policies, and mount the corrected policy set so existing public images also work.
install -d -m 0755 /etc/cloudbrowser/chrome-policies
browser_cid=$(docker create "$BROWSER_IMAGE")
docker cp "$browser_cid:/etc/opt/chrome/policies/managed/." /etc/cloudbrowser/chrome-policies/
docker rm "$browser_cid" >/dev/null
python3 - <<'POLICIES'
import json
from pathlib import Path
directory = Path('/etc/cloudbrowser/chrome-policies')
for path in directory.glob('*.json'):
    policy = json.loads(path.read_text())
    policy.pop('DeveloperToolsAvailability', None)
    policy.pop('IncognitoModeAvailability', None)
    path.write_text(json.dumps(policy))
path = directory / 'cloudbrowser.json'
policy = json.loads(path.read_text())
policy.update(DeveloperToolsAvailability=1, IncognitoModeAvailability=0)
path.write_text(json.dumps(policy))
POLICIES
grep -Fq '/etc/cloudbrowser/chrome-policies:' /etc/systemd/system/cloudbrowser-browser.service || \\
  sed -i 's|--env-file /run/cloudbrowser/neko.env|--env-file /run/cloudbrowser/neko.env -v /etc/cloudbrowser/chrome-policies:/etc/opt/chrome/policies/managed:ro|' /etc/systemd/system/cloudbrowser-browser.service

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
