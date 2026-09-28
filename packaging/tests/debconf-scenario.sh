#!/usr/bin/env bash
# One install scenario, run as root inside a Debian 13 container by
# debconf-test.sh. /t holds portikus.deb.
set -euo pipefail

scenario="$1"
CONFIG=/etc/portikus/portikus.yaml
SECRETS=/etc/portikus/secrets.yaml

fail() {
	echo "  $scenario: $*" >&2
	exit 1
}

# systemd is not running in the container; a stub records what postinst asks.
mkdir -p /run/systemd/system
cat >/usr/bin/systemctl <<'EOF'
#!/bin/sh
echo "$*" >>/tmp/systemctl.log
# is-active succeeds only for units listed in /tmp/active-units.
case "$1" in is-active) for unit; do :; done; grep -qxF "$unit" /tmp/active-units 2>/dev/null && exit 0; exit 3 ;; esac
exit 0
EOF
chmod 0755 /usr/bin/systemctl
: >/tmp/systemctl.log

# The real package needs ansible-core and friends from the archive.
if dpkg-deb -f /t/portikus.deb Depends | grep -q ansible-core; then
	apt-get update -qq
fi

install_with() {
	debconf-set-selections
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /t/portikus.deb \
		>/tmp/install.log 2>&1 || {
		cat /tmp/install.log >&2
		fail "apt-get install failed"
	}
}

# Prints a key of a YAML file as JSON, so lists and booleans compare exactly.
value() {
	python3 -c 'import json, sys, yaml; d = yaml.safe_load(open(sys.argv[1])) or {}; print(json.dumps(d.get(sys.argv[2])))' "$1" "$2"
}

expect() {
	local got
	got=$(value "$1" "$2")
	[ "$got" = "$3" ] || fail "$2 in $1 is $got, expected $3"
}

check_modes() {
	[ "$(stat -c '%a %U' "$CONFIG")" = "644 root" ] || fail "portikus.yaml mode is $(stat -c '%a %U' "$CONFIG")"
	[ "$(stat -c '%a %U' "$SECRETS")" = "600 root" ] || fail "secrets.yaml mode is $(stat -c '%a %U' "$SECRETS")"
}

# No secret may be in portikus.yaml or anywhere in the debconf database.
check_no_leak() {
	local secret
	for secret in "$@"; do
		grep -qsF "$secret" "$CONFIG" && fail "a secret is in portikus.yaml"
		debconf-show portikus | grep -qF "$secret" && fail "a secret is shown by debconf-show"
		grep -qF "$secret" /var/cache/debconf/config.dat /var/cache/debconf/passwords.dat &&
			fail "a secret is left in the debconf database"
	done
	return 0
}

setup_started() {
	grep -qx 'start --no-block portikus-setup.service' /tmp/systemctl.log
}

# check_started [again] -- again: a reconfigure, which names only how to follow setup.
check_started() {
	setup_started || fail "setup was not started"
	grep -qF 'sudo portikus setup --follow' /tmp/install.log || fail "how to follow setup was not printed"
	if [ "${1:-}" = again ]; then
		! grep -qF 'admin-password' /tmp/install.log || fail "a reconfigure printed the first sign-in steps"
	else
		grep -qF 'sudo cat /etc/portikus/admin-password' /tmp/install.log || fail "the next steps were not printed"
	fi
}

check_not_started() {
	! setup_started || fail "setup was started with incomplete answers"
	grep -qF "$1" /tmp/install.log || fail "the missing item '$1' was not named"
	grep -qF 'dpkg-reconfigure portikus' /tmp/install.log || fail "the fix command was not printed"
}

# The ui-* scenarios: apt install in a 100 by 30 tmux session with the
# whiptail frontend, answered with key presses.
ui_start() {
	tmux new-session -d -s ui -x 100 -y 30 \
		"DEBIAN_FRONTEND=dialog apt-get install -y -qq -o Dpkg::Use-Pty=0 /t/portikus.deb 2>/tmp/install.log; touch /tmp/ui-done; sleep 600"
}

# The screen's text as one line without the dialog border, so a phrase
# matches wherever whiptail wraps it.
screen() {
	tmux capture-pane -p -t ui | sed 's/^ *x //; s/ *x *$//' | tr -s ' \n' '  '
}

# wait_for TEXT -- fails when TEXT is not on the screen within 20 seconds.
wait_for() {
	for _ in $(seq 100); do
		screen | grep -qF -- "$1" && return 0
		sleep 0.2
	done
	screen >&2
	fail "the screen never showed: $1"
}

keys() {
	tmux send-keys -t ui "$@"
	sleep 0.3
}

typed() {
	tmux send-keys -t ui -l "$1"
	sleep 0.3
}

# Empties a text field that holds a suggestion.
clear_field() {
	for _ in $(seq 60); do
		tmux send-keys -t ui BSpace
	done
	sleep 0.3
}

ui_done() {
	for _ in $(seq 100); do
		[ ! -e /tmp/ui-done ] || return 0
		sleep 0.2
	done
	screen >&2
	fail "apt-get install did not finish"
}

# Welcome, then the web address and the suggested administrator email.
ui_first_screens() {
	wait_for "Welcome to Portikus"
	keys Enter
	wait_for "Web address of this server"
	clear_field
	typed "$1"
	keys Enter
	wait_for "Email of the Portikus administrator"
	keys Enter
}

# A server with one empty 500 GiB disk, /dev/sdb, and no volume group.
fake_one_disk() {
	cat >/usr/local/bin/lsblk <<'STUB'
#!/bin/sh
case "$*" in
"-dnp -o NAME,TYPE") echo "/dev/sdb disk" ;;
"-nro NAME /dev/sdb") echo sdb ;;
"-dno RO /dev/sdb") echo " 0" ;;
"-dno FSTYPE,PTTYPE,MOUNTPOINT /dev/sdb") echo "" ;;
"-dnbo SIZE /dev/sdb") echo 536870912000 ;;
*) exec /usr/bin/lsblk "$@" ;;
esac
STUB
	chmod 0755 /usr/local/bin/lsblk
}

case "$scenario" in
dex-file)
	install_with <<'EOF'
portikus portikus/public_host string portikus.example.edu
portikus portikus/admin_email string root@example.edu
portikus portikus/tls select internal
portikus portikus/provider select dex
portikus portikus/storage select file
portikus portikus/storage_size string 1
EOF
	check_modes
	expect "$CONFIG" portikus_public_host '"portikus.example.edu"'
	expect "$CONFIG" portikus_admin_email '"root@example.edu"'
	expect "$CONFIG" portikus_tls '"internal"'
	expect "$CONFIG" portikus_dex_upstream '"none"'
	expect "$CONFIG" portikus_storage '"file"'
	expect "$CONFIG" portikus_storage_size 1
	expect "$CONFIG" portikus_storage_confirm null
	expect "$CONFIG" portikus_dex_upstream_client_id null
	[ "$(python3 -c 'import yaml; print(yaml.safe_load(open("/etc/portikus/secrets.yaml")))')" = "{}" ] ||
		fail "secrets.yaml is not empty for a local-accounts site"
	check_started
	grep -qF 'Sign in at https://portikus.example.edu' /tmp/install.log || fail "sign-in line missing"
	grep -qF 'as root@example.edu' /tmp/install.log || fail "sign-in email missing"
	# The closing message fits an 80-column terminal.
	long=$(sed -n '/Portikus setup is running/,$p' /tmp/install.log | awk 'length > 78')
	[ -z "$long" ] || fail "the closing message has a line over 78 columns: $long"
	;;
entra-vg)
	install_with <<'EOF'
portikus portikus/public_host string portikus.example.edu
portikus portikus/tls select letsencrypt
portikus portikus/acme_email string certs@example.edu
portikus portikus/cloudflare_api_token password CF-TOKEN-entra-0123456789abcdef
portikus portikus/provider select entra
portikus portikus/entra_tenant_id string 12345678-90ab-cdef-1234-567890abcdef
portikus portikus/client_id string entra-client-id
portikus portikus/client_secret password ENTRA-SECRET-0123456789abcdef
portikus portikus/storage select data-vg
EOF
	check_modes
	expect "$CONFIG" portikus_admin_email '"admin@portikus.example.edu"'
	expect "$CONFIG" portikus_tls '"letsencrypt"'
	expect "$CONFIG" portikus_acme_email '"certs@example.edu"'
	expect "$CONFIG" portikus_dex_upstream '"entra"'
	expect "$CONFIG" portikus_entra_tenant_id '"12345678-90ab-cdef-1234-567890abcdef"'
	expect "$CONFIG" portikus_dex_upstream_client_id '"entra-client-id"'
	expect "$CONFIG" portikus_storage '"data-vg"'
	expect "$CONFIG" portikus_oidc_student_group null
	expect "$SECRETS" portikus_cloudflare_api_token '"CF-TOKEN-entra-0123456789abcdef"'
	expect "$SECRETS" portikus_dex_upstream_client_secret '"ENTRA-SECRET-0123456789abcdef"'
	check_no_leak CF-TOKEN-entra-0123456789abcdef ENTRA-SECRET-0123456789abcdef
	check_started
	;;
google-disk)
	mkdir -p /etc/ssl/portikus
	echo cert >/etc/ssl/portikus/cert.pem
	echo key >/etc/ssl/portikus/key.pem
	install_with <<'EOF'
portikus portikus/public_host string portikus.example.edu
portikus portikus/tls select files
portikus portikus/tls_cert string /etc/ssl/portikus/cert.pem
portikus portikus/tls_key string /etc/ssl/portikus/key.pem
portikus portikus/provider select google
portikus portikus/google_domains string example.edu students.example.edu
portikus portikus/client_id string google-client-id.apps.googleusercontent.com
portikus portikus/client_secret password GOOGLE-SECRET-0123456789abcdef
portikus portikus/storage select /dev/nvme1n1
portikus portikus/storage_confirm boolean true
EOF
	check_modes
	expect "$CONFIG" portikus_tls '"files"'
	expect "$CONFIG" portikus_tls_cert '"/etc/ssl/portikus/cert.pem"'
	expect "$CONFIG" portikus_tls_key '"/etc/ssl/portikus/key.pem"'
	expect "$CONFIG" portikus_acme_email null
	expect "$CONFIG" portikus_dex_upstream '"google"'
	expect "$CONFIG" portikus_google_domains '["example.edu", "students.example.edu"]'
	expect "$CONFIG" portikus_storage '"/dev/nvme1n1"'
	expect "$CONFIG" portikus_storage_confirm true
	expect "$SECRETS" portikus_cloudflare_api_token null
	expect "$SECRETS" portikus_dex_upstream_client_secret '"GOOGLE-SECRET-0123456789abcdef"'
	check_no_leak GOOGLE-SECRET-0123456789abcdef
	check_started
	;;
ldap-unconfirmed)
	install_with <<'EOF'
portikus portikus/public_host string portikus.example.edu
portikus portikus/tls select internal
portikus portikus/provider select ldap
portikus portikus/ldap_host string ad.example.edu:636
portikus portikus/ldap_schema select ad
portikus portikus/ldap_ip_allow string 10.0.0.5, 10.0.1.0/24
portikus portikus/ldap_bind_dn string cn=portikus,ou=Services,dc=example,dc=edu
portikus portikus/ldap_bind_password password LDAP-PASSWORD-0123456789
portikus portikus/ldap_user_base_dn string ou=People,dc=example,dc=edu
portikus portikus/ldap_user_filter string (memberOf=cn=portikus-users,ou=Groups,dc=example,dc=edu)
portikus portikus/ldap_group_base_dn string ou=Groups,dc=example,dc=edu
portikus portikus/student_group string students
portikus portikus/storage select /dev/sdb
EOF
	check_modes
	expect "$CONFIG" portikus_dex_upstream '"ldap"'
	expect "$CONFIG" portikus_ldap_host '"ad.example.edu:636"'
	expect "$CONFIG" portikus_ldap_schema '"ad"'
	expect "$CONFIG" portikus_ldap_ip_allow '["10.0.0.5", "10.0.1.0/24"]'
	expect "$CONFIG" portikus_ldap_user_filter '"(memberOf=cn=portikus-users,ou=Groups,dc=example,dc=edu)"'
	expect "$CONFIG" portikus_ldap_root_ca '""'
	expect "$CONFIG" portikus_oidc_student_group '"students"'
	expect "$CONFIG" portikus_oidc_admin_group '"portikus-administrators"'
	expect "$CONFIG" portikus_storage_confirm false
	expect "$SECRETS" portikus_ldap_bind_password '"LDAP-PASSWORD-0123456789"'
	check_no_leak LDAP-PASSWORD-0123456789
	check_not_started "everything on /dev/sdb may be erased (storage_confirm)"
	;;
oidc-missing-secret)
	install_with <<'EOF'
portikus portikus/public_host string portikus.example.edu
portikus portikus/tls select internal
portikus portikus/provider select oidc
portikus portikus/oidc_issuer string https://login.example.edu/realms/main
portikus portikus/client_id string portikus
portikus portikus/storage select file
portikus portikus/storage_size string 2
EOF
	check_modes
	expect "$CONFIG" portikus_dex_upstream '"oidc"'
	expect "$CONFIG" portikus_dex_upstream_issuer '"https://login.example.edu/realms/main"'
	expect "$CONFIG" portikus_oidc_upstream_groups_claim '"groups"'
	expect "$CONFIG" portikus_oidc_instructor_group '"portikus-instructors"'
	check_not_started "the client secret (client_secret)"
	;;
reconfigure)
	install_with <<'EOF'
portikus portikus/public_host string portikus.example.edu
portikus portikus/tls select internal
portikus portikus/provider select oidc
portikus portikus/oidc_issuer string https://login.example.edu/realms/main
portikus portikus/client_id string portikus
portikus portikus/client_secret password OIDC-SECRET-0123456789abcdef
portikus portikus/storage select file
portikus portikus/storage_size string 3
EOF
	check_started
	# An operator's own key and a hand edit of an answer both survive.
	cat >>"$CONFIG" <<'EOF'
portikus_public_port: 8443
EOF
	sed -i 's/^portikus_public_host: .*/portikus_public_host: lab.example.edu/' "$CONFIG"
	: >/tmp/systemctl.log
	# A blank password keeps the stored secret.
	echo 'portikus portikus/client_secret password ' | debconf-set-selections
	DEBIAN_FRONTEND=noninteractive dpkg-reconfigure portikus >/tmp/install.log 2>&1 || {
		cat /tmp/install.log >&2
		fail "dpkg-reconfigure failed"
	}
	check_modes
	expect "$CONFIG" portikus_public_port 8443
	expect "$CONFIG" portikus_public_host '"lab.example.edu"'
	expect "$CONFIG" portikus_storage_size 3
	expect "$SECRETS" portikus_dex_upstream_client_secret '"OIDC-SECRET-0123456789abcdef"'
	check_no_leak OIDC-SECRET-0123456789abcdef
	check_started again
	# Switching to local accounts drops the provider's settings and secret.
	echo 'portikus portikus/provider select dex' | debconf-set-selections
	sed -i 's/^portikus_dex_upstream: .*/portikus_dex_upstream: none/' "$CONFIG"
	DEBIAN_FRONTEND=noninteractive dpkg-reconfigure portikus >/tmp/install.log 2>&1 || fail "second reconfigure failed"
	expect "$CONFIG" portikus_dex_upstream '"none"'
	expect "$CONFIG" portikus_dex_upstream_issuer null
	expect "$CONFIG" portikus_public_port 8443
	expect "$SECRETS" portikus_dex_upstream_client_secret null
	;;
no-debconf-keys)
	# A portikus.yaml that holds none of the debconf keys must not stop the config script.
	mkdir -p /etc/portikus
	echo 'portikus_public_port: 8443' >"$CONFIG"
	install_with <<'EOF'
portikus portikus/public_host string portikus.example.edu
portikus portikus/tls select internal
portikus portikus/provider select dex
portikus portikus/storage select file
portikus portikus/storage_size string 1
EOF
	expect "$CONFIG" portikus_public_port 8443
	expect "$CONFIG" portikus_public_host '"portikus.example.edu"'
	check_started
	;;
unanswered)
	# A non-interactive install with no preseed, as `make deploy-app` does.
	install_with </dev/null
	[ ! -e "$CONFIG" ] || { cat /tmp/install.log; fail "portikus.yaml was written from defaults"; }
	[ ! -e "$SECRETS" ] || fail "secrets.yaml was written from defaults"
	! setup_started || fail "setup was started with no answers"
	grep -qF 'Portikus is not configured yet: run dpkg-reconfigure portikus' /tmp/install.log ||
		fail "the not-configured line was not printed"
	;;
unconfigured-secret)
	# A secret preseeded without the web address: setup does not start, and
	# the secret still leaves debconf.
	install_with <<'EOF'
portikus portikus/client_secret password UNUSED-SECRET-0123456789abcdef
EOF
	[ ! -e "$CONFIG" ] || fail "portikus.yaml was written without a web address"
	! setup_started || fail "setup was started with no web address"
	check_no_leak UNUSED-SECRET-0123456789abcdef
	;;
setup-running)
	# A change made while setup still runs is not applied, and postinst says so.
	echo portikus-setup.service >/tmp/active-units
	install_with <<'EOF'
portikus portikus/public_host string portikus.example.edu
portikus portikus/tls select internal
portikus portikus/provider select dex
portikus portikus/storage select file
portikus portikus/storage_size string 1
EOF
	! setup_started || fail "setup was started while it was already running"
	grep -qF 'Setup is already running with the earlier answers; when it ends, run: sudo portikus setup' /tmp/install.log ||
		fail "the already-running line was not printed"
	! grep -qF 'is running in the background' /tmp/install.log || fail "postinst claimed the change is being applied"
	;;
ui-storage-default)
	# With exactly one empty disk the suggestion is still the file, and the
	# erase question still defaults to No.
	fake_one_disk
	ui_start
	ui_first_screens portikus.example.edu
	wait_for "HTTPS certificate"
	keys Down Down Enter
	wait_for "How people sign in"
	keys Enter
	wait_for "Where to keep student files"
	screen | grep -qF "/dev/sdb - an empty disk of 500 GiB" || fail "the empty disk is not offered"
	keys Enter
	wait_for "Size of the storage file"
	keys Escape
	wait_for "Where to keep student files"
	keys Up Enter
	wait_for "Erase /dev/sdb?"
	keys Enter
	wait_for "Save these answers and start setup?"
	screen | grep -qF "NOT confirmed" || fail "the erase question did not default to No"
	keys Enter
	ui_done
	expect "$CONFIG" portikus_storage '"/dev/sdb"'
	expect "$CONFIG" portikus_storage_confirm false
	;;
ui-host-short)
	# A host name without a dot is not suggested, so typing the name works.
	ui_start
	wait_for "Welcome to Portikus"
	keys Enter
	wait_for "Web address of this server"
	typed portikus.example.edu
	keys Enter
	wait_for "Email of the Portikus administrator"
	screen | grep -qF "admin@portikus.example.edu" || fail "the web address was not what was typed"
	;;
ui-host-full)
	ui_start
	wait_for "Welcome to Portikus"
	keys Enter
	wait_for "Web address of this server"
	wait_for "lab.example.edu"
	keys Enter
	wait_for "admin@lab.example.edu"
	;;
ui-summary-no)
	# No on the summary returns to the first question with every answer
	# kept, the hidden token included.
	ui_start
	ui_first_screens portikus.example.edu
	wait_for "HTTPS certificate"
	keys Enter
	wait_for "Email for Let's Encrypt"
	keys Enter
	wait_for "Cloudflare API token"
	typed CF-TOKEN-ui-0123456789abcdef
	keys Enter
	wait_for "How people sign in"
	keys Escape
	wait_for "Cloudflare API token"
	wait_for "Leave blank to keep the value you entered"
	keys Enter
	wait_for "How people sign in"
	keys Enter
	wait_for "Size of the storage file"
	clear_field
	typed 1
	keys Enter
	wait_for "Save these answers and start setup?"
	keys Tab Enter
	wait_for "Web address of this server"
	wait_for "portikus.example.edu"
	clear_field
	typed lab.example.edu
	keys Enter
	wait_for "Email of the Portikus administrator"
	screen | grep -qF "admin@portikus.example.edu" || fail "the administrator's email was not kept"
	keys Enter
	wait_for "HTTPS certificate"
	keys Enter
	wait_for "Email for Let's Encrypt"
	keys Enter
	wait_for "Cloudflare API token"
	keys Enter
	wait_for "How people sign in"
	keys Enter
	wait_for "Size of the storage file"
	keys Enter
	wait_for "Save these answers and start setup?"
	screen | grep -qF "https://lab.example.edu" || fail "the summary does not show the new web address"
	keys Enter
	ui_done
	expect "$CONFIG" portikus_public_host '"lab.example.edu"'
	expect "$CONFIG" portikus_admin_email '"admin@portikus.example.edu"'
	expect "$CONFIG" portikus_storage_size 1
	expect "$SECRETS" portikus_cloudflare_api_token '"CF-TOKEN-ui-0123456789abcdef"'
	check_no_leak CF-TOKEN-ui-0123456789abcdef
	check_started
	;;
ui-cert)
	# The certificate and key must parse, and the key must match.
	echo "not a certificate" >/root/junk.pem
	openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=portikus.example.edu -days 1 \
		-keyout /root/key.pem -out /root/cert.pem 2>/dev/null
	openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /root/other.pem 2>/dev/null
	ui_start
	ui_first_screens portikus.example.edu
	wait_for "HTTPS certificate"
	keys Down Enter
	wait_for "Certificate file"
	typed /root/junk.pem
	keys Enter
	wait_for "is not a PEM certificate"
	keys Enter
	wait_for "Certificate file"
	clear_field
	typed /root/cert.pem
	keys Enter
	wait_for "Private key file"
	typed /root/junk.pem
	keys Enter
	wait_for "is not a PEM private key"
	keys Enter
	wait_for "Private key file"
	clear_field
	typed /root/other.pem
	keys Enter
	wait_for "does not match the certificate"
	keys Enter
	wait_for "Private key file"
	clear_field
	typed /root/key.pem
	keys Enter
	wait_for "How people sign in"
	keys Enter
	wait_for "Size of the storage file"
	clear_field
	typed 1
	keys Enter
	wait_for "Save these answers and start setup?"
	keys Enter
	ui_done
	expect "$CONFIG" portikus_tls_cert '"/root/cert.pem"'
	expect "$CONFIG" portikus_tls_key '"/root/key.pem"'
	;;
*)
	fail "unknown scenario"
	;;
esac
