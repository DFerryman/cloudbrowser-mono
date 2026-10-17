# Images

- `browser/`: neko v3 + Google Chrome container (managed policies, CJK fonts, launch flags, neko
  config). Build: `docker build -t cloudbrowser-browser images/browser`.
- `vm/`: Packer template for the golden VM image (Ubuntu 24.04, containerd, nftables baseline,
  the agent as a systemd unit, browser image pre-pulled). Build after the provider trial:
  `GOOS=linux GOARCH=amd64 go build -o services/agent/dist/agent-linux-amd64 ./services/agent/cmd/agent`,
  then `packer build -var browser_image=<ref@digest> images/vm`.

Neither image has been built yet: they are written to the plan (pages 3–5) and are verified in the
provider trial (page 11), where the neko paths and flags are confirmed against the pinned version.
