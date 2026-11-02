#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo 'Source this file: source scripts/use-toolchain.sh' >&2
  exit 1
fi

node_version='26.13.0'
pnpm_version='12.16.1'
gitleaks_version='8.30.1'
toolchain_root="${XDG_DATA_HOME:-$HOME/.local/share}/slack-agent-starter/toolchains"
node_directory="${toolchain_root}/node-v${node_version}-linux-x64"
pnpm_directory="${toolchain_root}/pnpm-${pnpm_version}"
gitleaks_directory="${toolchain_root}/gitleaks-${gitleaks_version}"

missing_tools=()
[[ -x "${node_directory}/bin/node" ]] || missing_tools+=("${node_directory}/bin/node")
[[ -x "${pnpm_directory}/bin/pnpm" ]] || missing_tools+=("${pnpm_directory}/bin/pnpm")
[[ -x "${gitleaks_directory}/gitleaks" ]] || missing_tools+=("${gitleaks_directory}/gitleaks")

if (( ${#missing_tools[@]} > 0 )); then
  printf 'Pinned toolchain is missing: %s\n' "${missing_tools[*]}" >&2
  echo 'Run scripts/bootstrap-toolchain.sh first.' >&2
  return 1
fi

export PATH="${node_directory}/bin:${pnpm_directory}/bin:${gitleaks_directory}:${PATH}"

node --version
pnpm --version
gitleaks version
