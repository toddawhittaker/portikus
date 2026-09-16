#!/usr/bin/env bash
# Build a workspace image on the platform VM using distrobuilder.
# Called by: make build-workspace-image
# Expects to run from /var/lib/portikus/image-build after rsync.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VERSION_FILE="${SCRIPT_DIR}/VERSION"
YAML_FILE="${SCRIPT_DIR}/portikus.yaml"
OUTPUT_BASE="/var/lib/portikus/images"

if [[ ! -f "${VERSION_FILE}" ]]; then
  echo "error: ${VERSION_FILE} not found" >&2
  exit 1
fi
if [[ ! -f "${YAML_FILE}" ]]; then
  echo "error: ${YAML_FILE} not found" >&2
  exit 1
fi

VERSION="$(cat "${VERSION_FILE}")"
if [[ -z "${VERSION}" ]]; then
  echo "error: VERSION file is empty" >&2
  exit 1
fi

OUTPUT_DIR="${OUTPUT_BASE}/${VERSION}"
ALIAS_VERSIONED="portikus-${VERSION}"
ALIAS_LATEST="portikus"

echo "Building workspace image version ${VERSION}"

# Create the output directory.
mkdir -p "${OUTPUT_DIR}"

# Build the image with distrobuilder.
sudo distrobuilder build-incus \
  "${YAML_FILE}" "${OUTPUT_DIR}" \
  -o image.serial="${VERSION}" \
  -o image.release=bookworm

# Remove any existing image with the versioned alias so re-runs replace it.
if incus image info "${ALIAS_VERSIONED}" --project portikus >/dev/null 2>&1; then
  echo "Removing existing image with alias ${ALIAS_VERSIONED}"
  incus image delete "${ALIAS_VERSIONED}" --project portikus
fi

# Remove any existing image with the latest alias.
if incus image info "${ALIAS_LATEST}" --project portikus >/dev/null 2>&1; then
  echo "Removing existing image with alias ${ALIAS_LATEST}"
  incus image delete "${ALIAS_LATEST}" --project portikus
fi

# Import the built image into Incus.
incus image import \
  "${OUTPUT_DIR}/incus.tar.xz" \
  "${OUTPUT_DIR}/rootfs.squashfs" \
  --project portikus \
  --alias "${ALIAS_VERSIONED}" \
  --alias "${ALIAS_LATEST}"

echo "Image imported as ${ALIAS_VERSIONED} (also aliased as ${ALIAS_LATEST})"
