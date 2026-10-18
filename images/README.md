# Images

- `browser/`: neko v3 + Google Chrome container (managed policies, CJK fonts, launch flags, neko
  config). Build: `docker build -t cloudbrowser-browser images/browser`.
- `vm/`: Packer template for the golden VM image (Ubuntu 24.04, containerd, nftables baseline,
  the agent as a systemd unit, browser image pre-pulled). Build:
  `GOOS=linux GOARCH=amd64 go build -o services/agent/dist/agent-linux-amd64 ./services/agent/cmd/agent`,
  then `packer build -var browser_image=<ref@digest> images/vm`.

The browser image is built by `.github/workflows/images.yml` and runs on AWS EC2, the only
provider. The Packer golden image is written but not built yet; VMs use stock Ubuntu plus the
first-boot script until it is.
