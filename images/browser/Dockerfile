# Browser image: neko v3 + Google Chrome (pages 3-5). The base is pinned by digest
# (`docker buildx imagetools inspect ghcr.io/m1k1o/neko/google-chrome:<tag>`); images are
# signed with cosign in CI and the agent checks the signature before running one.
# neko 3.2.0 fixes WebRTC timestamp drift and stale frames piling up; the agent's protocol
# (login, system/init, signal/*, control/*, screen/*, signal/video) is unchanged from 3.0.8.
FROM ghcr.io/m1k1o/neko/google-chrome:3.2.0@sha256:0609ca9ec35a2745a189b3b4934ea609f71feb12a1a67c33df65f556599c7a7f

USER root
# Fixed font set including CJK, so pages render the same on every wake (stable fingerprint, page 4).
# Chrome is the current stable release at build time, not the one the neko base was built with
# (neko 3.0.8 shipped Chrome 140 from September 2025): an outdated Chrome lacks security fixes and is
# flagged by sites. The Images workflow rebuilds weekly to follow each stable release.
# CHROME_VERSION (the Images workflow passes the current stable) only invalidates the cached layer;
# the download is always the newest stable.
ARG CHROME_VERSION=latest
RUN echo "Chrome stable: ${CHROME_VERSION}" \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji fonts-liberation wget \
 && wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
 && google-chrome --version \
 && rm -rf /tmp/google-chrome.deb /var/lib/apt/lists/*

# Managed policies (page 3: no proxy, WebRTC public interface only, no DoH, no geolocation;
# page 4: restore tabs on startup). neko's own policy set is replaced, not merged: it is built for
# a shared kiosk and blocks every download and file dialog, the password manager, autofill,
# bookmarks, notifications and every extension but two it force-installs. A user's own browser
# should behave like a local Chrome, so only the restrictions in policies.json remain.
RUN rm -f /etc/opt/chrome/policies/managed/policies.json
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
