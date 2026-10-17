# Golden VM image (page 2, images/vm): Ubuntu 24.04 LTS with containerd, the agent, the nftables
# baseline and the browser image pre-pulled. No user data. Built weekly in CI and only in CI.
# This template targets the aws-ec2 executor; an oci-compute source is added if the trial picks
# Oracle Cloud (page 9).
packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = ">= 1.3.0"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-northeast-1"
}
variable "browser_image" {
  type        = string
  description = "Browser image reference pinned by digest, e.g. ghcr.io/<org>/cloudbrowser-browser@sha256:..."
}
variable "agent_binary" {
  type    = string
  default = "../../services/agent/dist/agent-linux-amd64"
}

source "amazon-ebs" "ubuntu" {
  region        = var.region
  instance_type = "m7i.large"
  ssh_username  = "ubuntu"
  ami_name      = "cloudbrowser-{{timestamp}}"
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }
  # IMDSv2 only, and one hop: the browser container cannot reach the metadata service (page 4).
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  tags = {
    "cb:managed" = "true"
    "cb:kind"    = "image"
  }
}

build {
  sources = ["source.amazon-ebs.ubuntu"]

  provisioner "file" {
    source      = var.agent_binary
    destination = "/tmp/cloudbrowser-agent"
  }
  provisioner "file" {
    source      = "files/"
    destination = "/tmp/cloudbrowser"
  }
  provisioner "shell" {
    environment_vars = ["BROWSER_IMAGE=${var.browser_image}"]
    script           = "files/provision.sh"
    execute_command  = "sudo -E bash '{{ .Path }}'"
  }
}
