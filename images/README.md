# Images

- `browser/`: neko v3 + Google Chrome container (managed policies, CJK fonts, launch flags, neko
  config). `neko.yaml` is the Basic live view (VP8, up to 25 fps on a 30 Hz desktop);
  `neko-premium.yaml` is Premium's (H.264, up to 60 fps on a 60 Hz desktop), chosen by the VM with
  `NEKO_CONFIG` when its first boot says `BROWSER_TIER=premium`. The build adds 60 Hz desktop modes
  for 1600×900, 1368×768 and 2560×1440, and rebuilds neko's server from the same release with
  `browser/neko/*.patch` (a keyframe whenever a viewer asks for one, and a budget for resending
  lost packets; see the Dockerfile). Build: `docker build -t cloudbrowser-browser images/browser`
  (the neko stage fetches its source from GitHub and Go modules from the Go proxy).
- `vm/`: Packer template for the golden VM image (Ubuntu 24.04, containerd, nftables baseline,
  the agent as a systemd unit, browser image pre-pulled). Build:
  `GOOS=linux GOARCH=amd64 go build -o services/agent/dist/agent-linux-amd64 ./services/agent/cmd/agent`,
  then `packer build -var browser_image=<ref@digest> images/vm`.

The browser image is built by `.github/workflows/images.yml` and runs on AWS EC2, the only
provider. The Packer golden image is written but not built yet; VMs use stock Ubuntu plus the
first-boot script until it is.
