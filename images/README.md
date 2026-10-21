# Images

- `browser/`: neko v3 + Google Chrome container (managed policies, CJK fonts, launch flags, neko
  config). `neko.yaml` is the live view of every browser, Basic and Premium alike (H.264, up to
  30 fps on a 30 Hz desktop). The build rebuilds neko's server from the same release with
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
