#!/usr/bin/env bash
# Checks the install settings keys in packaging/debian/settings-keys against
# the debconf templates and config, postinst, and the Ansible play, so a key
# added or renamed in one place cannot be silently ignored in another
# (docs/SPEC.md section 21.12). Usage: packaging/tests/settings-keys-test.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
keys="$repo_root/packaging/debian/settings-keys"
templates="$repo_root/packaging/debian/templates"
config="$repo_root/packaging/debian/config"
postinst="$repo_root/packaging/scripts/postinst"
site="$repo_root/infra/ansible/site.yml"
failures=0

fail() {
	echo "settings-keys: $1" >&2
	failures=$((failures + 1))
}

list=$(grep -v '^#' "$keys" | awk 'NF { print $1, $2, $3 }')
steps=$(sed -n '/^STEPS="/,/"$/p' "$config" | sed 's/^STEPS=//' | tr -d '"' | tr -s ' \n' '\n')

while read -r question key kind; do
	case "$kind" in
	setting | secret) ;;
	*) fail "$question has kind '$kind', not setting or secret" ;;
	esac
	grep -qx "Template: portikus/$question" "$templates" || fail "$question has no debconf template"
	grep -qx "$question" <<<"$steps" || fail "$question is not a step in packaging/debian/config"
	grep -Eq "^    $key:" "$site" || fail "$key is not a play variable in infra/ansible/site.yml"
done <<<"$list"

# Every question with a template, except the three screens, is in the list.
while read -r question; do
	case "$question" in welcome | error | summary) continue ;; esac
	grep -q "^$question " <<<"$list" || fail "template portikus/$question is not in settings-keys"
done < <(sed -n 's|^Template: portikus/||p' "$templates")

# The config script reads portikus.yaml back into the same questions.
while read -r key question; do
	grep -qx "$question $key setting" <<<"$list" || fail "config maps $key to $question, which settings-keys does not"
done < <(grep -oE '"portikus_[a-z_]+": "[a-z_]+"' "$config" | tr -d '":')
while read -r key; do
	grep -q "\"$key\":" "$config" || fail "$key is not read back by packaging/debian/config"
done < <(awk '$3 == "setting" { print $2 }' <<<"$list")

# Every key postinst names is in the list. portikus_public_port is only
# read, and a name ending in _ is a prefix postinst completes in a loop.
while read -r key; do
	case "$key" in portikus_public_port | *_) continue ;; esac
	grep -q " $key " <<<"$list" || fail "postinst names $key, which is not in settings-keys"
done < <(grep -oE 'portikus_[a-z_]+' "$postinst" | sort -u)

# postinst's reads of the list skip comment lines, as the reads above do.
probe=$(mktemp)
trap 'rm -f "$probe"' EXIT
{
	cat "$keys"
	echo '#retired portikus_retired setting'
	echo '#retired portikus_retired secret'
} >"$probe"
while read -r program; do
	if awk "$program" "$probe" | grep -q retired; then
		fail "postinst's awk '$program' reads comment lines"
	fi
done < <(grep -oE "awk '[^']+'" "$postinst" | sed -e "s/^awk '//" -e "s/'\$//")

if [ "$failures" -gt 0 ]; then
	echo "settings-keys: $failures problem(s)" >&2
	exit 1
fi
echo "settings-keys: $(wc -l <<<"$list") keys agree across debconf, postinst and site.yml"
