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
# Premium browsers stream at 60 fps (the VM sets NEKO_CONFIG to this file; Basic keeps neko.yaml).
COPY neko-premium.yaml /etc/neko/neko-premium.yaml
# Chrome draws no faster than the desktop's refresh rate, and the viewer picks a desktop size that
# fits the window. neko's X server has 60 Hz modes for 1920x1080, 1280x720 and the VESA sizes;
# add common laptop sizes (GTF timings, like neko's own lines) and 2560x1440, so Premium keeps
# 60 fps in every window size the viewer uses. 2560x1440 has short blanking to stay under the
# dummy driver's 300 MHz pixel clock (GTF needs 312), yet not the CVT reduced-blanking shape
# that X refuses without a monitor that declares it. Measured on 4 vCPUs at 2560x1440: 59 fps
# while scrolling with 78% of the VM busy, 57 fps playing 1080p60 video with 86% busy (c7i's
# faster cores leave more room). Basic is unaffected: these sizes already have 30 or 25 Hz modes,
# and its viewer stays at or below 30.
RUN sed -i \
      -e '/Modeline "1920x1080_60.00"/a\  Modeline "2560x1440_60.00" 243.12 2560 2608 2648 2736 1440 1443 1448 1481 -HSync +Vsync\n  Modeline "1600x900_60.00" 119.00 1600 1696 1864 2128 900 901 904 932 -HSync +Vsync\n  Modeline "1368x768_60.00" 85.86 1368 1440 1584 1800 768 769 772 795 -HSync +Vsync' \
      -e 's/Modes "1920x1080_60.00"/Modes "1920x1080_60.00" "2560x1440_60.00" "1600x900_60.00" "1368x768_60.00"/' \
      /etc/neko/xorg.conf \
 && test "$(grep -c '2560x1440_60.00\|1600x900_60.00\|1368x768_60.00' /etc/neko/xorg.conf)" = 4

# Supervisor needs root to manage its pid/socket and drop privileges for its programs.
# neko and Chrome run as the unprivileged `neko` user in their supervisor configurations.
LABEL org.opencontainers.image.source="https://github.com/DFerryman/cloudbrowser-mono"
LABEL org.opencontainers.image.description="CloudBrowser browser image: neko v3 + Google Chrome"

USER root
