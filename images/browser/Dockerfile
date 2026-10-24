# Browser image: neko v3 + Google Chrome (pages 3-5). The base is pinned by digest
# (`docker buildx imagetools inspect ghcr.io/m1k1o/neko/google-chrome:<tag>`); images are
# signed with cosign in CI and the agent checks the signature before running one.
# neko 3.2.0 fixes WebRTC timestamp drift and stale frames piling up; the agent's protocol
# (login, system/init, signal/*, control/*, screen/*, signal/video) is unchanged from 3.0.8.

# neko's server, rebuilt from the same release with neko/*.patch (measured in docs/aws.md):
# - neko 3.2.0 ignores a viewer's keyframe request (RTCP PLI/FIR), so a frame lost beyond what
#   retransmission repairs froze the picture until the encoder's next periodic keyframe;
#   patched, the next frame is a keyframe.
# - It resent every packet a viewer reported lost, all at once, which on a busy path overflowed
#   it again and collapsed the stream into retransmissions; patched, resends have a budget.
# - A desktop size it creates on request (a viewer's own shape) took libxcvt's pixel clock, which
#   put short ones such as 1424×504 below 29.5 Hz, so XRandR refused them at 30; patched, the
#   clock is exact (neko/exact-refresh.patch).
# Built as neko's own server/Dockerfile does (Go 1.25 on Debian trixie, the base image's OS);
# NEKO_BUILD_IMAGE is an argument only so a local build can add a proxy's CA certificate.
ARG NEKO_BUILD_IMAGE=golang:1.25-trixie@sha256:2c4c60ef415fbfa5e90300722293bef36c5e63fae17570ce18f580af933dbd73
FROM ${NEKO_BUILD_IMAGE} AS neko
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends libx11-dev libxrandr-dev libxtst-dev libgtk-3-dev libxcvt-dev \
      libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
 && rm -rf /var/lib/apt/lists/*
# v3.2.0 (the tag the base image is built from), fetched by commit so a moved tag cannot change it.
ARG NEKO_COMMIT=92420ca8e4709c1ac49961c4bf5d3cc786d44f0d
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/m1k1o/neko.git \
 && git fetch -q --depth 1 origin "$NEKO_COMMIT" && git checkout -q FETCH_HEAD
COPY neko/ /patches/
RUN git apply /patches/*.patch && cd server && ./build core && go test ./internal/webrtc/ && ./bin/neko --version >/dev/null

FROM ghcr.io/m1k1o/neko/google-chrome:3.2.0@sha256:0609ca9ec35a2745a189b3b4934ea609f71feb12a1a67c33df65f556599c7a7f

USER root
# Fixed font set including CJK, so pages render the same on every wake (stable fingerprint, page 4).
# fonts-noto-core covers the scripts the others lack (Thai, Khmer, Myanmar, Sinhala, Ethiopic and
# more), which otherwise show as empty boxes; it adds about 19 MB to the image download and 45 MB
# on disk, and makes Noto Sans and Noto Serif the generic sans-serif and serif fonts (DejaVu before).
# Chrome is the current stable release at build time, not the one the neko base was built with
# (neko 3.0.8 shipped Chrome 140 from September 2025): an outdated Chrome lacks security fixes and is
# flagged by sites. The Images workflow rebuilds weekly to follow each stable release.
# CHROME_VERSION (the Images workflow passes the current stable) only invalidates the cached layer;
# the download is always the newest stable.
ARG CHROME_VERSION=latest
RUN echo "Chrome stable: ${CHROME_VERSION}" \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-core fonts-noto-color-emoji fonts-liberation wget \
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
COPY --from=neko /src/server/bin/neko /usr/bin/neko
COPY neko.yaml /etc/neko/neko.yaml

# Supervisor needs root to manage its pid/socket and drop privileges for its programs.
# neko and Chrome run as the unprivileged `neko` user in their supervisor configurations.
LABEL org.opencontainers.image.source="https://github.com/DFerryman/cloudbrowser-mono"
LABEL org.opencontainers.image.description="CloudBrowser browser image: neko v3 + Google Chrome"

USER root
