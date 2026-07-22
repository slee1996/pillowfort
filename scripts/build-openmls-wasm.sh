#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPOSITORY_ROOT="$(CDPATH= cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
CRATE_DIRECTORY="${REPOSITORY_ROOT}/crypto/openmls-wasm"
OUTPUT_DIRECTORY="${REPOSITORY_ROOT}/client/src/vendor/openmls"
WASM_BINDGEN_VERSION="0.2.120"
PINNED_TOOLCHAIN="1.94.1"
BUILD_TARGET_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/pillowfort-openmls-target.XXXXXX")"

cleanup() {
  rm -rf -- "${BUILD_TARGET_DIRECTORY}"
}
trap cleanup EXIT HUP INT TERM

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup with the pinned ${PINNED_TOOLCHAIN} toolchain is required" >&2
  exit 1
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "wasm-bindgen ${WASM_BINDGEN_VERSION} is required" >&2
  exit 1
fi
if [[ "$(wasm-bindgen --version)" != "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]]; then
  echo "wasm-bindgen ${WASM_BINDGEN_VERSION} is required" >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIRECTORY}"
PINNED_CARGO="$(rustup which --toolchain "${PINNED_TOOLCHAIN}" cargo)"
PINNED_RUSTC="$(rustup which --toolchain "${PINNED_TOOLCHAIN}" rustc)"
RUSTC="${PINNED_RUSTC}" "${PINNED_CARGO}" build \
  --manifest-path "${CRATE_DIRECTORY}/Cargo.toml" \
  --target-dir "${BUILD_TARGET_DIRECTORY}" \
  --target wasm32-unknown-unknown \
  --release \
  --locked

wasm-bindgen \
  "${BUILD_TARGET_DIRECTORY}/wasm32-unknown-unknown/release/pillowfort_openmls_wasm.wasm" \
  --out-dir "${OUTPUT_DIRECTORY}" \
  --out-name pillowfort_openmls \
  --target web \
  --typescript

echo "OpenMLS browser adapter written to ${OUTPUT_DIRECTORY}"
