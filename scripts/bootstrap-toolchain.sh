#!/usr/bin/env bash

set -euo pipefail

node_version='26.13.0'
pnpm_version='12.16.1'
gitleaks_version='8.30.1'

node_archive="node-v${node_version}-linux-x64.tar.xz"
node_archive_sha256='d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997'
gitleaks_archive="gitleaks_${gitleaks_version}_linux_x64.tar.gz"
gitleaks_archive_sha256='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'

if [[ "$(uname -m)" != 'x86_64' ]]; then
  echo 'This bootstrap supports x86_64 Linux.' >&2
  exit 1
fi

for command_name in curl sha256sum tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

toolchain_root="${XDG_DATA_HOME:-$HOME/.local/share}/slack-agent-starter/toolchains"
node_directory="${toolchain_root}/node-v${node_version}-linux-x64"
pnpm_directory="${toolchain_root}/pnpm-${pnpm_version}"
gitleaks_directory="${toolchain_root}/gitleaks-${gitleaks_version}"

mkdir -p "$toolchain_root"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

if [[ ! -x "${node_directory}/bin/node" ]]; then
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v${node_version}/${node_archive}" \
    --output "${temporary_directory}/${node_archive}"
  printf '%s  %s\n' "$node_archive_sha256" "${temporary_directory}/${node_archive}" \
    | sha256sum --check --status
  tar --extract --xz --file "${temporary_directory}/${node_archive}" \
    --directory "$toolchain_root"
fi

node_executable="${node_directory}/bin/node"
npm_executable="${node_directory}/bin/npm"
pnpm_entry_point="${pnpm_directory}/lib/node_modules/pnpm/bin/pnpm.mjs"

if [[ ! -f "$pnpm_entry_point" ]]; then
  PATH="${node_directory}/bin:${PATH}" \
    "$npm_executable" install --global --prefix "$pnpm_directory" "pnpm@${pnpm_version}"
fi

gitleaks_executable="${gitleaks_directory}/gitleaks"
if [[ ! -x "$gitleaks_executable" ]]; then
  curl --fail --location --silent --show-error \
    "https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks_version}/${gitleaks_archive}" \
    --output "${temporary_directory}/${gitleaks_archive}"
  printf '%s  %s\n' "$gitleaks_archive_sha256" "${temporary_directory}/${gitleaks_archive}" \
    | sha256sum --check --status
  mkdir -p "$gitleaks_directory"
  tar --extract --gzip --file "${temporary_directory}/${gitleaks_archive}" \
    --directory "$gitleaks_directory" gitleaks
fi

"$node_executable" --version
"$node_executable" "$pnpm_entry_point" --version
"$gitleaks_executable" version

echo 'Toolchain installed without changing the user or system PATH.'
echo 'Source scripts/use-toolchain.sh in each development shell.'
