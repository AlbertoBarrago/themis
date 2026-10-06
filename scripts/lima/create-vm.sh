#!/usr/bin/env bash
# Creates and provisions the dedicated Lima VM where Themis runs agents (ADR 0013).
#
# Usage: scripts/lima/create-vm.sh [instance]   (default instance: themis)
#
# The VM mounts only ~/themis-workspaces (writable) at the same path as on the host, so
# projects run by agents must live there. Nothing else from the host is visible.
# After this script, authenticate Claude Code once: limactl shell <instance>, then claude.

set -euo pipefail

INSTANCE="${1:-themis}"
WORKSPACES="${THEMIS_WORKSPACES:-$HOME/themis-workspaces}"

if limactl list --format '{{.Name}}' | grep -qx "$INSTANCE"; then
  echo "instance $INSTANCE already exists; delete it first (limactl delete $INSTANCE) to recreate" >&2
  exit 2
fi
mkdir -p "$WORKSPACES"

# `--mount-none` cannot be combined with `--mount`, so the template's mount list (which
# includes the whole home directory) is replaced outright.
limactl create --tty=false --name="$INSTANCE" \
  --cpus=4 --memory=8 \
  --set=".mounts = [{\"location\": \"$WORKSPACES\", \"writable\": true}]" \
  template:docker
limactl start --tty=false "$INSTANCE"

limactl shell --tty=false "$INSTANCE" -- bash -euo pipefail -c '
  if ! command -v node >/dev/null || ! node -e "process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  sudo apt-get install -y git
  if ! command -v claude >/dev/null; then
    curl -fsSL https://claude.ai/install.sh | bash
  fi
  grep -q ".local/bin" ~/.profile || echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.profile
  git config --global user.name "Themis agent"
  git config --global user.email "themis@localhost"
  node --version; git --version; docker --version; "$HOME/.local/bin/claude" --version
'

echo "VM $INSTANCE ready. Authenticate Claude Code once: limactl shell $INSTANCE, then run claude"
