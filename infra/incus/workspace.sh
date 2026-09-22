#!/usr/bin/env bash
# Workspace helper for image builds, the smoke test, and operator cleanup.
# Runs on the platform VM as the deploy user (member of incus-admin).
# In normal operation the control plane (Epic 3) creates, starts, and stops
# workspaces; the controller has no destroy call, so `destroy` here is the
# operator path for removing an instance and its volumes.
#
# Usage:
#   workspace.sh create <name>
#   workspace.sh destroy <name>
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
POOL="workspace-data"
PROJECT="portikus"
PROFILE="workspace"
IMAGE="portikus"
HOME_SIZE="25GB"
DOCKER_SIZE="20GB"
RECOVERY_SIZE="3GiB"
RECOVERY_PATH="/var/lib/portikus/recovery"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
die() { echo "error: $*" >&2; exit 1; }

# The incus CLI reads a YAML config from standard input whenever standard
# input is not a terminal, so a command run over ssh from an interactive
# shell blocks forever waiting for end-of-file. Nothing here feeds incus on
# standard input, so every call gets /dev/null.
incus_cmd() { incus "$@" < /dev/null; }

validate_name() {
    local name="$1"
    if [[ ! "$name" =~ ^[a-z][a-z0-9-]{0,30}$ ]]; then
        die "name must match ^[a-z][a-z0-9-]{0,30}\$ (got: ${name})"
    fi
}

container_exists() {
    incus_cmd info "$1" --project "$PROJECT" >/dev/null 2>&1
}

volume_exists() {
    incus_cmd storage volume show "$POOL" "custom/$1" --project "$PROJECT" >/dev/null 2>&1
}

# Ensure a custom storage volume exists with the given size.
# If it already exists (e.g. data from a previous container), skip creation
# so a re-create reuses existing data (SPEC 4.4).
ensure_volume() {
    local vol_name="$1" size="$2"
    if volume_exists "$vol_name"; then
        echo "volume ${vol_name} already exists, reusing"
    else
        # security.shifted is NOT set.  The Incus docs describe it as
        # "Enable ID shifting overlay (allows attach by multiple isolated
        # instances)."  Each workspace volume is attached to exactly one
        # container, so the default UID/GID write-on-first-attach that
        # Incus performs with security.idmap.isolated=true is sufficient.
        # Shifted would add an unnecessary shiftfs/idmapped-mount overlay.
        incus_cmd storage volume create "$POOL" "$vol_name" \
            --project "$PROJECT" \
            size="$size"
        echo "created volume ${vol_name} (${size})"
    fi
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd_create() {
    local name="$1"
    validate_name "$name"

    if container_exists "$name"; then
        die "container ${name} already exists in project ${PROJECT}"
    fi

    # Persistent volumes (SPEC 4.4, 16.2, 19.1).
    ensure_volume "${name}-home" "$HOME_SIZE"
    ensure_volume "${name}-docker" "$DOCKER_SIZE"
    ensure_volume "${name}-recovery" "$RECOVERY_SIZE"

    # Create the container from the workspace image and profile.
    incus_cmd init "$IMAGE" "$name" \
        --project "$PROJECT" \
        --profile "$PROFILE"

    # Attach persistent volumes as disk devices.
    incus_cmd config device add "$name" home disk \
        pool="$POOL" \
        source="${name}-home" \
        path="/home/student" \
        --project "$PROJECT"

    incus_cmd config device add "$name" docker disk \
        pool="$POOL" \
        source="${name}-docker" \
        path="/var/lib/docker" \
        --project "$PROJECT"

    # Recovery points live on their own volume (ADR 0020).
    incus_cmd config device add "$name" recovery disk \
        pool="$POOL" \
        source="${name}-recovery" \
        path="$RECOVERY_PATH" \
        --project "$PROJECT"

    incus_cmd start "$name" --project "$PROJECT"

    # Wait for an IPv4 address (up to 60 seconds).
    local waited=0 ip=""
    while [[ $waited -lt 60 ]]; do
        ip=$(incus_cmd list "$name" --project "$PROJECT" \
            --format csv --columns 4 2>/dev/null \
            | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || true)
        if [[ -n "$ip" ]]; then
            break
        fi
        sleep 2
        waited=$((waited + 2))
    done

    # A new volume's root belongs to root; the agent runs as the student.
    incus_cmd exec "$name" --project "$PROJECT" -- chown 1000:1000 "$RECOVERY_PATH"
    incus_cmd exec "$name" --project "$PROJECT" -- chmod 0700 "$RECOVERY_PATH"

    if [[ -z "$ip" ]]; then
        echo "workspace ${name} started but no IPv4 address after 60 s"
    else
        echo "workspace ${name} ready at ${ip}"
    fi
}

cmd_destroy() {
    local name="$1"
    validate_name "$name"

    if container_exists "$name"; then
        incus_cmd delete --force "$name" --project "$PROJECT"
        echo "deleted container ${name}"
    else
        echo "container ${name} does not exist, skipping"
    fi

    for suffix in home docker recovery; do
        local vol="${name}-${suffix}"
        if volume_exists "$vol"; then
            incus_cmd storage volume delete "$POOL" "$vol" --project "$PROJECT"
            echo "deleted volume ${vol}"
        else
            echo "volume ${vol} does not exist, skipping"
        fi
    done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if [[ $# -lt 2 ]]; then
    die "usage: workspace.sh {create|destroy} <name>"
fi

command="$1"
name="$2"

case "$command" in
    create)  cmd_create "$name" ;;
    destroy) cmd_destroy "$name" ;;
    *)       die "unknown command: ${command} (use create or destroy)" ;;
esac
