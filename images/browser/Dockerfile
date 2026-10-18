# Browser image: neko v3 + Google Chrome (pages 3-5). Pin the base by digest when the trial picks a
# version (`docker buildx imagetools inspect ghcr.io/m1k1o/neko/google-chrome:<tag>`); images are
# signed with cosign in CI and the agent checks the signature before running one.
FROM ghcr.io/m1k1o/neko/google-chrome:3.0.8

USER root
# Fixed font set including CJK, so pages render the same on every wake (stable fingerprint, page 4).
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Managed policies (page 3: no proxy, WebRTC public interface only, no DoH, no geolocation;
# page 4: restore tabs on startup).
# The upstream policies disable DevTools and incognito, which the agent needs for its CDP
# connection and isolated IP checks. Keep every other upstream policy.
RUN python3 -c 'import json,pathlib,sys; p=pathlib.Path(sys.argv[1]); data=json.loads(p.read_text()); data.pop("DeveloperToolsAvailability",None); data.pop("IncognitoModeAvailability",None); p.write_text(json.dumps(data)+"\n")' /etc/opt/chrome/policies/managed/policies.json
COPY policies.json /etc/opt/chrome/policies/managed/cloudbrowser.json
# Chrome launch flags: profile on the data volume, stable cookie encryption, bounded cache,
# DevTools on the loopback interface for the agent only.
COPY google-chrome.conf /etc/neko/supervisord/google-chrome.conf
COPY neko.yaml /etc/neko/neko.yaml

# Supervisor needs root to manage its pid/socket and drop privileges for its programs.
# neko and Chrome run as the unprivileged `neko` user in their supervisor configurations.
LABEL org.opencontainers.image.source="https://github.com/DFerryman/cloudbrowser-mono"
LABEL org.opencontainers.image.description="CloudBrowser browser image: neko v3 + Google Chrome"

USER root
