#!/usr/bin/env bash
# The data of a backup set just restored onto this VM.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# Only when PORTIKUS_SMOKE_RESTORED_SET names the set restored onto this VM.
# Everything read from the set is matched against a strict form before it
# reaches a command, as restore.sh does.
restored_ids=()
if [ -n "$RESTORED_SET" ]; then
  echo "--- Restored data from $(basename "$RESTORED_SET") ---"
  echo ""
  psql_vm() { ssh_cmd "sudo -u postgres psql -q -t -A -d portikus -c \"$1\""; }
  restored_file_sum() { # VOLUME PATH
    ssh_cmd "incus storage volume file pull workspace-data $(printf '%q' "$1/$2") - --project portikus" | sha256sum | cut -d' ' -f1
  }
  # restored_sample INDEX -- three files spread evenly through the backup's
  # file list, as restore.sh samples, each from the middle of its stretch so
  # the first file (often .bash_history, which a started workspace may
  # change) is not picked.  Only plain relative paths are used.
  restored_sample() {
    python3 - "$1" <<'EOF_SAMPLE'
import json, re, sys
files = [r for r in map(json.loads, open(sys.argv[1])) if "f" in r
         and re.fullmatch(r"[A-Za-z0-9._@+/-]+", r["f"]) and not r["f"].startswith("/")
         and ".." not in r["f"].split("/") and re.fullmatch(r"[0-9a-f]{64}", r.get("sha256", ""))]
step = max(1, len(files) // 3)
for r in files[step // 2::step][:3]:
    print(r["sha256"], r["f"])
EOF_SAMPLE
  }

  restore_tmp=$(mktemp -d)
  if ! age -d -i "$BACKUP_IDENTITY" "${RESTORED_SET}/MANIFEST.age" >"${restore_tmp}/MANIFEST"; then
    bad "decrypt the MANIFEST of ${RESTORED_SET} with ${BACKUP_IDENTITY}"
  else
    # Every workspace row, including one whose instance was never created.
    while read -r _ id instance; do
      if ! [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        bad "a MANIFEST workspace line is not in the expected form"
        continue
      fi
      restored_ids+=("$id")
      if [ "$instance" = "-" ]; then
        check_output "restored workspace ${id} is there, with no instance yet" "1" \
          psql_vm "SELECT count(*) FROM workspaces WHERE id = '${id}' AND incus_instance_name IS NULL"
      elif [[ "$instance" =~ ^ws-[0-9a-f]{24}$ ]]; then
        check_output "restored workspace ${id} keeps instance ${instance}" "$instance" \
          psql_vm "SELECT incus_instance_name FROM workspaces WHERE id = '${id}'"
        check "restored instance ${instance} exists" \
          ssh_cmd "incus info ${instance} --project portikus"
      else
        bad "the MANIFEST instance for ${id} is not in the expected form"
      fi
    done < <(awk '$1 == "workspace"' "${restore_tmp}/MANIFEST")
    [ "${#restored_ids[@]}" -gt 0 ] || bad "the MANIFEST lists no workspace"

    while read -r _ volume _; do
      if ! [[ "$volume" =~ ^ws-[0-9a-f]{24}-(home|recovery)$ ]]; then
        bad "a MANIFEST volume line is not in the expected form"
        continue
      fi
      check "restored volume ${volume} exists" \
        ssh_cmd "incus storage volume show workspace-data ${volume} --project portikus"
      if ! age -d -i "$BACKUP_IDENTITY" "${RESTORED_SET}/${volume}.index.age" >"${restore_tmp}/index"; then
        bad "decrypt the file list of ${volume}"
        continue
      fi
      sampled=0
      while read -r sum path; do
        sampled=$((sampled + 1))
        check_output "restored ${volume}: sampled file ${sampled} matches the backup" "$sum" \
          restored_file_sum "$volume" "$path"
      done < <(restored_sample "${restore_tmp}/index")
      # A home always holds files, so an empty sample means the check is broken.
      if [ "$sampled" -eq 0 ] && [[ "$volume" == *-home ]]; then
        bad "no file of ${volume} could be sampled from the backup"
      fi
    done < <(awk '$1 == "volume"' "${restore_tmp}/MANIFEST")

    projects=$(awk '$1 == "counts" && $6 == "projects" { print $7 }' "${restore_tmp}/MANIFEST")
    if [[ "$projects" =~ ^[0-9]+$ ]]; then
      check "at least the backup's ${projects} projects are on the VM" \
        test "$(psql_vm 'SELECT count(*) FROM projects')" -ge "$projects"
    else
      bad "the MANIFEST has no counts line"
    fi

    # restore.sh ends every sign-in; nothing made before the backup survives.
    created=$(awk '$1 == "created" { print $2 }' "${restore_tmp}/MANIFEST")
    if [[ "$created" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]]; then
      at="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}+00"
      check_output "no session from before the backup survived" "0" \
        psql_vm "SELECT count(*) FROM sessions WHERE created_at < '${at}'"
      check_output "no preview session from before the backup survived" "0" \
        psql_vm "SELECT count(*) FROM preview_sessions WHERE created_at < '${at}'"
    else
      bad "the MANIFEST has no created line"
    fi
  fi
  rm -rf "$restore_tmp"
  echo ""
fi
