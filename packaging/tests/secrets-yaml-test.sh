#!/usr/bin/env bash
# Checks that an empty secrets.yaml tells the operator to replace its `{}`
# line, and that `portikus setup` names a file that is not a YAML mapping
# without printing its contents (docs/SPEC.md section 21.12).
# Usage: packaging/tests/secrets-yaml-test.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
writer="$repo_root/packaging/site/write-settings"
portikus="$repo_root/packaging/bin/portikus"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

fail() {
	echo "secrets-yaml: $1" >&2
	failures=$((failures + 1))
}

# The settings writer's write() run on an empty mapping, as for a site with no secrets.
{
	echo "import os, yaml"
	sed -n '/^def write(/,/^$/p' "$writer"
	echo "write('$work/secrets.yaml', {}, 0o600, '# header' + chr(10))"
} >"$work/write.py"
python3 "$work/write.py"
grep -qx '{}' "$work/secrets.yaml" || fail "an empty secrets file no longer holds {}"
grep -q '^#.*[Rr]eplace.*{}' "$work/secrets.yaml" || fail "an empty file does not say to replace the {} line"
[ "$(stat -c '%a' "$work/secrets.yaml")" = 600 ] || fail "secrets file mode changed"

# The setup check, lifted out of bin/portikus.
sed -n '/^check_yaml_mapping() {/,/^}/p' "$portikus" >"$work/check.sh"
[ -s "$work/check.sh" ] || fail "bin/portikus has no check_yaml_mapping"
printf '{}\n' >"$work/good.yaml"
printf '{}\nportikus_alert_webhook_url: "s3cret-value"\n' >"$work/bad.yaml"
if ! sh -c ". '$work/check.sh'; check_yaml_mapping '$work/good.yaml'" 2>"$work/err"; then
	fail "{} was refused: $(cat "$work/err")"
fi
if sh -c ". '$work/check.sh'; check_yaml_mapping '$work/bad.yaml'" 2>"$work/err"; then
	fail "{} followed by a key was accepted"
fi
grep -q "$work/bad.yaml" "$work/err" || fail "the error does not name the file"
grep -q '{}' "$work/err" || fail "the error does not mention the {} line"
if grep -q 's3cret' "$work/err"; then fail "the error printed the file's contents"; fi

[ "$failures" = 0 ] || exit 1
echo "secrets-yaml: ok"
