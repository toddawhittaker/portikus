#!/usr/bin/env bash
# The Docker pull-through caches.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# The Hub cache on the gateway only, as its own sandboxed user, and the
# root cache helper's requests.  The ghcr.io switch and a credential are
# put back as they were; a site with a real Hub credential skips that check.
if ssh_cmd test -d /etc/portikus/registry; then
  echo "--- Docker registry caches ---"
  echo ""
  REG_JOBS=/var/lib/portikus/registry-jobs

  check_output "Debian's docker-registry.service is masked" "masked" \
    ssh_cmd "systemctl is-enabled docker-registry.service"
  # shellcheck disable=SC2016  # expanded on the VM
  check "docker-registry carries the CVE-2023-2253 fix (2.8.2 or later)" \
    ssh_cmd 'dpkg --compare-versions "$(dpkg-query -W -f "\${Version}" docker-registry)" ge 2.8.2'
  check_output "the Docker Hub cache is running" "active" \
    ssh_cmd "systemctl is-active portikus-registry-hub.service"
  check_output "the cache runs as its own user" "portikus-registry" \
    ssh_cmd "ps -o user= -p \$(systemctl show -p MainPID --value portikus-registry-hub.service)"
  check "the cache has MemoryMax= and TasksMax= set" \
    ssh_cmd "m=\$(systemctl show -p MemoryMax --value portikus-registry-hub.service); t=\$(systemctl show -p TasksMax --value portikus-registry-hub.service); [ \"\$m\" != infinity ] && [ \"\$t\" != infinity ]"
  registry_listeners() {
    ssh_cmd "sudo ss -Hltnp" | awk '/"docker-registry"/ { print $4 }' | sort | tr '\n' ' ' | sed 's/ $//'
  }
  reg_ghcr_before=$(ssh_cmd "cat /etc/portikus/registry/ghcr-enabled" 2>/dev/null)
  if [ "$reg_ghcr_before" = on ]; then
    check_output "the caches listen only on the gateway, with no debug port" "10.200.0.1:5000 10.200.0.1:5001" registry_listeners
    check "the loaded egress table sends workspace ghcr.io traffic to the cache" \
      ssh_cmd "sudo nft list chain inet portikus_egress prerouting | grep -q 'tcp dport 443 redirect to :5001'"
  else
    check_output "the cache listens only on 10.200.0.1:5000, with no debug port" "10.200.0.1:5000" registry_listeners
  fi
  check "the Hub cache's config has the access log off and no debug listener" \
    ssh_cmd "sudo python3 -c 'import json,sys; c=json.loads(open(\"/etc/portikus/registry/hub.yml\").read().split(\"\\n\",1)[1]); sys.exit(0 if c[\"log\"][\"accesslog\"][\"disabled\"] and \"debug\" not in c[\"http\"] and c[\"log\"][\"level\"] in (\"warn\",\"error\") else 1)'"
  check_output "the Hub cache's config is readable by root and the cache only" "640 root portikus-registry" \
    ssh_cmd "sudo stat -c '%a %U %G' /etc/portikus/registry/hub.yml"
  # The HTTP status from the VM itself.  A PUT carries a well-formed
  # manifest, so the answer is the push refusal, not a parse error.
  reg_status() { # URL METHOD
    ssh_cmd_stdin "curl -sk -o /dev/null -w '%{http_code}' --max-time 10 -X $2 \
      -H 'Content-Type: application/vnd.docker.distribution.manifest.v2+json' --data-binary @- $1" \
      <<<'{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"mediaType":"application/vnd.docker.container.image.v1+json","size":2,"digest":"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"},"layers":[]}'
  }
  check_output "PUT to the Hub cache answers 405" "405" \
    reg_status http://10.200.0.1:5000/v2/library/smoke/manifests/latest PUT
  check_output "POST to the Hub cache answers 405" "405" \
    reg_status http://10.200.0.1:5000/v2/library/smoke/blobs/uploads/ POST
  check "the cache port is closed from the management network" \
    bash -c "! curl -s -o /dev/null --max-time 5 http://${VM}:5000/v2/"
  check "the firewall caps connections per workspace to the caches" \
    ssh_cmd "sudo nft list chain inet filter input | grep -q 'tcp dport { 5000, 5001 } ct state new add @registry_conns'"
  # The ACL's TCP drop on the gateway covers 443 and spares only the redirect targets and the caches.
  # shellcheck disable=SC2016  # expanded on the VM
  check "the workspace ACL keeps 443 on the gateway closed and 5000 and 5001 open" \
    ssh_cmd 'incus network acl show portikus-ws-acl | python3 -c "
import sys, yaml
rules = [r for r in yaml.safe_load(sys.stdin)[\"egress\"] if r[\"action\"] == \"drop\" and r.get(\"destination\") == \"10.200.0.1/32\" and r.get(\"protocol\") == \"tcp\"]
spans = [tuple(int(p) for p in (s.split(\"-\") * 2)[:2]) for s in rules[0][\"destination_port\"].split(\",\")]
covered = lambda port: any(a <= port <= b for a, b in spans)
sys.exit(0 if len(rules) == 1 and covered(443) and not covered(5000) and not covered(5001) else 1)"'
  check "the drop-all table closes the caches" \
    ssh_cmd "grep -qx 'add rule inet portikus_egress input iifname \"portikus-ws\" tcp dport { 5000, 5001 } drop' /etc/portikus/egress-drop-all.nft"
  check_output "the notification token is readable by root and the worker only" "640 root portikus-worker" \
    ssh_cmd "sudo stat -c '%a %U %G' /etc/portikus/registry/events-token"
  check_output "the ghcr.io authority's key is root's alone" "600 root root" \
    ssh_cmd "sudo stat -c '%a %U %G' /etc/portikus/registry/ghcr-ca.key"
  check "the ghcr.io authority may sign only ghcr.io" \
    ssh_cmd "openssl x509 -in /etc/portikus/registry/ghcr-ca.crt -noout -ext nameConstraints | grep -q 'DNS:ghcr.io'"
  # shellcheck disable=SC2016  # expanded on the VM
  check "the cache status file is fresh" \
    ssh_cmd 'sudo python3 -c "
import datetime, json, sys
s = json.load(open(\"/var/lib/portikus/registry-jobs/status.json\"))
age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(s[\"updatedAt\"].replace(\"Z\", \"+00:00\"))
sys.exit(0 if s[\"sizeBytes\"] > 0 and s[\"hubUp\"] and age.total_seconds() < 180 else 1)"'

  # A request as the API writes one (RegistryJobRequestFile): as the portikus
  # user, mode 0600, renamed into place.  Waits until the helper removed it.
  reg_request() { # JSON of the request
    local id
    id=$(cat /proc/sys/kernel/random/uuid)
    ssh_cmd_stdin "sudo -u portikus sh -c 'umask 077; cat > ${REG_JOBS}/.request-${id}.tmp && mv ${REG_JOBS}/.request-${id}.tmp ${REG_JOBS}/request-${id}.json'" \
      <<<"{\"id\":\"${id}\",\"requestedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"requestedBy\":\"00000000-0000-4000-8000-000000000000\",\"request\":$1}"
    ssh_cmd "for i in \$(seq 1 120); do sudo test -e ${REG_JOBS}/request-${id}.json || exit 0; sleep 1; done; exit 1" &&
      ssh_cmd "for i in \$(seq 1 120); do [ \"\$(systemctl show -p ActiveState --value portikus-registry-job.service)\" = activating ] || exit 0; sleep 1; done; exit 1"
  }
  reg_ghcr_state() {
    echo "$(ssh_cmd cat /etc/portikus/registry/ghcr-enabled) $(ssh_cmd systemctl is-active portikus-registry-ghcr.service)"
  }
  reg_wait_ghcr() {
    ssh_cmd "for i in \$(seq 1 30); do curl -sk -o /dev/null --max-time 2 https://10.200.0.1:5001/v2/ && exit 0; sleep 1; done; exit 1"
  }
  if [ "$reg_ghcr_before" != on ]; then
    check "the helper takes a set-ghcr request" reg_request '{"kind":"set-ghcr","enabled":true}'
    check_output "the ghcr.io cache is on" "on active" reg_ghcr_state
    check "the ghcr.io cache answers on 10.200.0.1:5001" reg_wait_ghcr
  fi
  check_output "PUT to the ghcr.io cache answers 405" "405" \
    reg_status https://10.200.0.1:5001/v2/smoke/x/manifests/latest PUT
  check_output "POST to the ghcr.io cache answers 405" "405" \
    reg_status https://10.200.0.1:5001/v2/smoke/x/blobs/uploads/ POST
  check "the ghcr.io cache presents the site's own ghcr.io certificate" \
    ssh_cmd "curl -s -o /dev/null --max-time 10 --cacert /etc/portikus/registry/ghcr-ca.crt --resolve ghcr.io:5001:10.200.0.1 https://ghcr.io:5001/v2/"
  if [ "$reg_ghcr_before" != on ]; then
    check "the helper takes a set-ghcr off request" reg_request '{"kind":"set-ghcr","enabled":false}'
    check_output "the ghcr.io cache is off again" "off inactive" reg_ghcr_state
  fi

  # A credential change clears the cache: a marker root leaves on the
  # cache's filesystem is gone after each.
  if ssh_cmd "sudo test -e /etc/portikus/registry/hub-credential.json"; then
    echo "SKIP  credential set and clear (a real Hub credential is set)"
  else
    ssh_cmd "sudo touch /var/lib/portikus-registry/.smoke-marker" >/dev/null 2>&1
    check "the helper takes a set-hub-credential request" \
      reg_request '{"kind":"set-hub-credential","username":"portikussmoke","token":"smoke-not-a-real-token"}'
    check "setting a credential cleared the cache" \
      ssh_cmd "sudo test ! -e /var/lib/portikus-registry/.smoke-marker"
    check "the request file is gone and no request file names the token" \
      ssh_cmd "! sudo grep -rqs smoke-not-a-real-token ${REG_JOBS}"
    check "the Hub config carries the credential" \
      ssh_cmd "sudo grep -q portikussmoke /etc/portikus/registry/hub.yml"
    ssh_cmd "sudo touch /var/lib/portikus-registry/.smoke-marker" >/dev/null 2>&1
    check "the helper takes a remove-hub-credential request" reg_request '{"kind":"remove-hub-credential"}'
    check "removing it cleared the cache and the config" \
      ssh_cmd "sudo test ! -e /var/lib/portikus-registry/.smoke-marker && ! sudo grep -q portikussmoke /etc/portikus/registry/hub.yml"
    check_output "the status says a credential cleared it" "credential False" \
      ssh_cmd "sudo python3 -c 'import json; s=json.load(open(\"${REG_JOBS}/status.json\")); print(s[\"lastClearReason\"], s[\"hubCredentialSet\"])'"
    check_output "the Hub cache is running again" "active" \
      ssh_cmd "systemctl is-active portikus-registry-hub.service"
  fi
  check "a refused request is deleted and changes nothing" \
    reg_request '{"kind":"rm","path":"/"}'
  echo ""
fi
