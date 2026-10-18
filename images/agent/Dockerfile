# Agent image: not run as a container. A VM's first-boot script copies the agent binary and the VM
# files (systemd units, scripts, nftables rules) out of it (packages/executors/src/aws/user-data.ts).
# Build context: the repository root.
FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY services/agent/go.mod services/agent/go.sum ./
RUN go mod download
COPY services/agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /cloudbrowser-agent ./cmd/agent

FROM scratch
COPY --from=build /cloudbrowser-agent /cloudbrowser-agent
COPY images/vm/files/bin/ /vm/bin/
COPY images/vm/files/systemd/ /vm/systemd/
COPY images/vm/files/nft/ /vm/nft/
LABEL org.opencontainers.image.source="https://github.com/DFerryman/cloudbrowser-mono"
LABEL org.opencontainers.image.description="CloudBrowser agent binary and VM files"
CMD ["/cloudbrowser-agent"]
