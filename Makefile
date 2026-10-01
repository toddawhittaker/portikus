# Documented operator entry point (STACK.md section 31).
# Every target is a thin wrapper over a tool that stays usable on its own.

.PHONY: help install check docs-check typecheck lint format test test-coverage build test-e2e dev clean \
       infra-check bootstrap-host wait-vm infra-plan infra-apply configure-vm smoke-test security-test destroy-pilot rebuild-pilot \
       publish-vm unpublish-vm rehearsal-up rehearsal-destroy rehearsal-preflight tofu-destroy install-test \
       build-deb install-screens deploy-app build-workspace-image workspace-create workspace-destroy \
       backup-setup backup backup-install-timer backup-install-channel backup-install-key restore \
       mock-lms lti-mock-register lti-mock-unregister

help: ## Show the available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install workspace dependencies from the lockfile
	pnpm install --frozen-lockfile

check: typecheck lint docs-check test-coverage build infra-check ## Run every repository check, including the infrastructure checks CI runs

docs-check: ## Fail on Markdown links and images that point at missing files
	python3 scripts/check-docs-links.py

typecheck: ## Type-check every package and app
	pnpm typecheck

lint: ## Lint and check formatting with Biome
	pnpm lint

format: ## Rewrite files to the Biome format
	pnpm format

test: ## Run the Vitest unit and integration tests
	pnpm test

test-coverage: ## Run the Vitest tests with coverage and check the coverage floors
	pnpm test:coverage

build: ## Build every package and app
	pnpm build

test-e2e: ## Run the Playwright browser end-to-end tests
	pnpm test:e2e

dev: ## Run every app in watch mode
	pnpm dev

clean: ## Remove build output
	rm -rf dist apps/*/dist packages/*/dist apps/*/.tsbuild packages/*/.tsbuild coverage playwright-report test-results
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete

# ── Infrastructure targets (STACK.md section 31) ─────────────────

# TOFU_ENV picks the OpenTofu environment: dev-libvirt is the live pilot,
# rehearsal-libvirt the throwaway VM beside it (docs/archive/epics/EPIC-12B.md).
TOFU_ENV ?= dev-libvirt
TOFU_DIR := infra/tofu/environments/$(TOFU_ENV)

# The rehearsal state lives outside the repository so every worktree shares it.
REHEARSAL_STATE ?= $(HOME)/.local/state/portikus/rehearsal-libvirt/terraform.tfstate
REHEARSAL_SSH_KEY ?= $(HOME)/.ssh/id_ed25519.pub
REHEARSAL_VCPUS ?= 12
REHEARSAL_MEMORY_MB ?= 24576

# tofu_attr TYPE,NAME,PATH -- one attribute of a resource, read straight from
# the state file so no `tofu init` is needed; PATH is dot-separated.
tofu_attr = $(shell python3 -c 'import functools, json, sys; a = next(r["instances"][0]["attributes"] for r in json.load(open(sys.argv[1]))["resources"] if r["type"] == sys.argv[2] and r["name"] == sys.argv[3]); print(functools.reduce(lambda v, k: v[int(k)] if k.isdigit() else v[k], sys.argv[4].split("."), a))' '$(TOFU_STATE)' $(1) $(2) $(3) 2>/dev/null)

ifeq ($(TOFU_ENV),dev-libvirt)
TOFU_STATE := $(TOFU_DIR)/terraform.tfstate
TOFU_INIT_ARGS :=
else ifeq ($(TOFU_ENV),rehearsal-libvirt)
TOFU_STATE := $(REHEARSAL_STATE)
TOFU_INIT_ARGS := -backend-config=path=$(REHEARSAL_STATE)
export TF_VAR_ssh_public_key := $(shell cat $(REHEARSAL_SSH_KEY) 2>/dev/null)
export TF_VAR_vcpus := $(REHEARSAL_VCPUS)
export TF_VAR_memory_mb := $(REHEARSAL_MEMORY_MB)
# The disk never shrinks, so the default is the size it was last grown to.
rehearsal_disk_bytes := $(call tofu_attr,terraform_data,data_disk_size,triggers_replace.value)
REHEARSAL_DATA_DISK_GB ?= $(if $(rehearsal_disk_bytes),$(shell echo $$(( $(rehearsal_disk_bytes) / 1073741824 ))),100)
export TF_VAR_data_disk_size_bytes := $(shell echo $$(( $(REHEARSAL_DATA_DISK_GB) * 1073741824 )))
# Its accounts come from a restored dex.dump or the local administrator the
# play makes, never the pilot's retired users file, whose import would make
# restore.sh refuse the VM.
# An exported PORTIKUS_USERS_FILE does not override this; the command line does.
PORTIKUS_USERS_FILE := /nonexistent
else
$(error TOFU_ENV must be dev-libvirt or rehearsal-libvirt, not '$(TOFU_ENV)')
endif

# Read straight from the state file, so no `tofu init` is needed to learn it.
tofu_output = $(shell python3 -c 'import json, sys; v = json.load(open(sys.argv[1]))["outputs"][sys.argv[2]]["value"]; print(v[0] if isinstance(v, list) else v)' '$(TOFU_STATE)' $(1) 2>/dev/null)
TOFU_VM_NAME = $(call tofu_attr,libvirt_domain,vm,name)

# First recipe line of every OpenTofu target: name the VM, and never let a
# non-pilot environment act on a state file that holds the pilot.
TOFU_BANNER = @echo "$@: OpenTofu environment $(TOFU_ENV), state $(TOFU_STATE), VM '$(or $(TOFU_VM_NAME),<none yet>)'"; \
	test "$(TOFU_ENV)" = dev-libvirt || test "$(TOFU_VM_NAME)" != portikus || { echo "$@: that state holds the pilot VM; refusing"; exit 1; }

# Recipe line for targets that need the VM; $(call REQUIRE_VM_IP,<target>)
# names a different make target to run first than infra-apply.
REQUIRE_VM_IP = @test -n "$(VM_IP)" || { echo "$@: no VM address; run make $(or $(1),infra-apply) first or pass VM_IP=<ip>"; exit 1; }

rehearsal-up: ## Create or update the rehearsal VM beside the pilot and wait for it (REHEARSAL_VCPUS, REHEARSAL_MEMORY_MB, REHEARSAL_DATA_DISK_GB size it)
	@$(MAKE) --no-print-directory TOFU_ENV=rehearsal-libvirt rehearsal-preflight infra-apply wait-vm

rehearsal-destroy: ## Destroy the rehearsal VM, its disks, network and pool (never the pilot), and forget its SSH host key in ~/.ssh/known_hosts
	@$(MAKE) --no-print-directory TOFU_ENV=rehearsal-libvirt TOFU_DESTROY_CALLER=rehearsal-destroy tofu-destroy

# The script fixes TOFU_ENV=rehearsal-libvirt and ignores VM_IP, so it cannot reach the pilot.
install-test: ## apt install portikus on a fresh rehearsal VM from a local signed repository, claim the administrator, smoke test, upgrade, destroy it (IMAGE_JOBS=1 adds the image job rehearsal; UPGRADE_FROM_PUBLISHED=1 upgrades from the published release instead; KEEP_VM=1 keeps the VM)
	IMAGE_JOBS=$(IMAGE_JOBS) KEEP_VM=$(KEEP_VM) bash infra/tests/install-test.sh

# Refuses to start the VM when the host lacks its memory; a running VM is fine.
rehearsal-preflight:
	@test "$(TOFU_ENV)" = rehearsal-libvirt || { echo "rehearsal-preflight: TOFU_ENV must be rehearsal-libvirt"; exit 1; }
	@test -n "$(TF_VAR_ssh_public_key)" || { echo "rehearsal-preflight: no SSH public key at $(REHEARSAL_SSH_KEY); set REHEARSAL_SSH_KEY=<file>"; exit 1; }
	@mkdir -p "$(dir $(REHEARSAL_STATE))"
	@if [ "$$(virsh -c qemu:///system domstate portikus-rehearsal 2>/dev/null)" = running ]; then \
		echo "rehearsal-preflight: portikus-rehearsal is already running"; \
	else \
		avail=$$(free -m | awk '/^Mem:/ {print $$7}'); \
		if [ "$$avail" -lt $(REHEARSAL_MEMORY_MB) ]; then \
			echo "rehearsal-preflight: the host has $$avail MiB available, less than the VM's $(REHEARSAL_MEMORY_MB) MiB; lower REHEARSAL_MEMORY_MB or free memory"; exit 1; \
		fi; \
		echo "rehearsal-preflight: $$avail MiB available for a $(REHEARSAL_MEMORY_MB) MiB VM"; \
	fi

# Only rehearsal-destroy and destroy-pilot call this; each fixes TOFU_ENV
# and sets the private TOFU_DESTROY_CALLER so a direct call is refused.
# A recreated VM keeps its address (fixed MAC) but gets a new SSH host key,
# so the old one is forgotten; VM_IP is expanded before the destroy runs.
tofu-destroy:
	@test -n "$(TOFU_DESTROY_CALLER)" || { echo "tofu-destroy: use make destroy-pilot or make rehearsal-destroy"; exit 1; }
	$(TOFU_BANNER)
	cd $(TOFU_DIR) && tofu init -input=false $(TOFU_INIT_ARGS) && tofu destroy
	@ip='$(VM_IP)'; if [ -n "$$ip" ]; then ssh-keygen -R "$$ip" >/dev/null 2>&1 || true; echo "tofu-destroy: forgot $$ip's SSH host key in ~/.ssh/known_hosts"; fi

# Mirrors the "Infrastructure checks" job in .github/workflows/ci.yml.
infra-check: ## Run the infrastructure checks CI runs: tofu fmt/validate, ansible-lint, shellcheck
	@for t in tofu ansible-lint ansible-galaxy shellcheck; do \
		command -v $$t >/dev/null || { echo "infra-check: $$t is not installed (see docs/WORKFLOW.md, Local development)"; exit 1; }; \
	done
	tofu fmt -check -recursive infra/tofu
	for env in dev-libvirt rehearsal-libvirt; do \
		(cd infra/tofu/environments/$$env && tofu init -backend=false -input=false >/dev/null && tofu validate) || exit 1; \
	done
	bash infra/tests/vm-mac-test.sh
	ansible-galaxy collection install --force -r infra/ansible/requirements.yml
	ansible-lint infra/ansible
	cmp packages/ui/src/fonts/PublicSans-Variable.woff2 infra/ansible/roles/dex/files/theme/PublicSans-Variable.woff2 \
		|| { echo "infra-check: Dex's theme font differs from packages/ui/src/fonts; copy it over"; exit 1; }
	find . -name '*.sh' -not -path './node_modules/*' -not -path './dist/*' -not -path './.claude/*' -print0 | xargs -0 shellcheck && shellcheck packaging/scripts/* packaging/bin/portikus packaging/backup/backup-key infra/host/portikus-backup-export
	bash infra/tests/cleanup-scope-test.sh
	bash infra/tests/security-cleanup-scope-test.sh
	bash packaging/tests/settings-keys-test.sh
	bash infra/tests/clipboard-shim-test.sh
	bash infra/tests/claude-login-test.sh
	bash infra/tests/agent-clear-test.sh
	bash infra/tests/caddy-preview-test.sh
	bash infra/tests/lti-platforms-test.sh
	ansible-playbook infra/tests/dex-render-test.yml
	ansible-playbook infra/tests/egress-proxy-render-test.yml
	ansible-playbook infra/tests/workspace-egress-render-test.yml
	ansible-playbook infra/tests/setup-settings-test.yml
	ansible-playbook infra/tests/certificate-seed-test.yml
	ansible-playbook infra/tests/apt-failures-test.yml
	ansible-playbook infra/tests/workspace-image-test.yml
	ansible-playbook infra/tests/registry-cache-size-test.yml
	bash infra/tests/backup-scope-test.sh
	bash infra/tests/backup-channel-test.sh
	bash scripts/tests/publish-apt-repo-test.sh
	bash infra/tests/backup-local-test.sh

bootstrap-host: ## Install host prerequisites (KVM, libvirt, OpenTofu, Ansible, age, SOPS)
	bash infra/host/dev-libvirt/bootstrap.sh

infra-plan: ## Show what OpenTofu would change in the platform VM
	$(TOFU_BANNER)
	cd $(TOFU_DIR) && tofu init -input=false $(TOFU_INIT_ARGS) && tofu plan

infra-apply: ## Create or update the platform VM and disks (TOFU_ENV=rehearsal-libvirt for the rehearsal VM)
	$(TOFU_BANNER)
	cd $(TOFU_DIR) && tofu init -input=false $(TOFU_INIT_ARGS) && tofu apply

# The VM address comes from OpenTofu state; override with VM_IP=<ip>. The
# state has none after an apply that only started a stopped VM, so fall back
# to libvirt's DHCP lease for the domain this environment's state names.
vm_lease_cmd = virsh -q -c qemu:///system domifaddr --source lease '$(TOFU_VM_NAME)' 2>/dev/null | awk '$$3 == "ipv4" { sub("/.*", "", $$4); print $$4; exit }'
VM_IP ?= $(or $(call tofu_output,vm_ip),$(if $(TOFU_VM_NAME),$(shell $(vm_lease_cmd))))
MANAGEMENT_CIDR ?= $(call tofu_output,management_cidr)

# The host's own LAN address, taken from its default route.
HOST_IP ?= $(shell ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($$i == "src") { print $$(i + 1); exit }}')

# The account SSH and Ansible use on the VM: the one cloud-init makes on the
# libvirt VMs.  It needs passwordless sudo.
SSH_USER ?= deploy

# Non-empty when VM_IP names a host other than this state's libvirt VM.
FOREIGN_HOST = $(and $(filter command line environment,$(origin VM_IP)),$(filter-out $(call tofu_output,vm_ip),$(VM_IP)))

# The site name the VM's Caddy serves. The pilot has a real DNS name on the
# LAN resolver.  Other libvirt VMs from a state here are named after the
# host's address through nip.io, because LAN browsers reach them through the
# host port forward.  Any other host is named after its own address, as the
# play itself would name it.
PILOT_PUBLIC_HOST := pilot.portikus.thewhittakers.org
PORTIKUS_PUBLIC_HOST ?= $(if $(FOREIGN_HOST),portikus.$(VM_IP).nip.io,$(if $(filter dev-libvirt,$(TOFU_ENV)),$(PILOT_PUBLIC_HOST),portikus.$(HOST_IP).nip.io))

# The port browsers connect to. The host keeps 80 and 443 for another
# service, so Caddy on the VM serves the site on 8443 and the host forwards
# that port straight through.
PORTIKUS_PUBLIC_PORT ?= 8443

# Workspace storage (docs/SPEC.md section 21.12). OpenTofu gives each libvirt VM
# an empty second disk for it, so erasing that disk is confirmed here.  Any
# other host must name its own.
PORTIKUS_STORAGE ?= $(if $(FOREIGN_HOST),,/dev/vdb)
PORTIKUS_STORAGE_CONFIRM ?= $(if $(FOREIGN_HOST),,true)
# none: these VMs build their image with make build-workspace-image rather
# than download a published one.
PORTIKUS_IMAGE_VERSION ?= none

# Block until the VM answers SSH and cloud-init has finished, so Ansible does
# not race the first-boot apt update. A host without cloud-init is ready once
# it answers. The known-hosts options are for the wait only: a rebuilt VM has
# a new host key at the same address.
wait-vm: ## Wait for the platform VM to finish first boot
	@ip='$(VM_IP)'; \
	if [ -z "$$ip" ] && [ -n '$(TOFU_VM_NAME)' ]; then \
		echo "wait-vm: no address in the state; waiting for libvirt to lease one to '$(TOFU_VM_NAME)'"; \
		for i in $$(seq 1 24); do ip=$$($(vm_lease_cmd)); [ -n "$$ip" ] && break; sleep 5; done; \
	fi; \
	test -n "$$ip" || { echo "wait-vm: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }; \
	for i in $$(seq 1 60); do \
		ssh -n -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
			-o LogLevel=ERROR '$(SSH_USER)'@$$ip 'command -v cloud-init >/dev/null || exit 0; cloud-init status --wait >/dev/null 2>&1; cloud-init status' 2>/dev/null && exit 0; \
		sleep 5; \
	done; echo "wait-vm: $$ip did not become ready"; exit 1

# Ansible runs from infra/ansible, so a local package path has to be absolute.
PORTIKUS_DEB_ABS := $(if $(PORTIKUS_DEB),$(abspath $(PORTIKUS_DEB)),)

# ── Sign-in provider and accounts (docs/adr/0023, docs/adr/0031) ───
# PORTIKUS_IDP is dex (the default) or mock (test only: anyone can sign in
# as anyone).  An institution's provider is one Dex connector, named by
# PORTIKUS_DEX_UPSTREAM: ldap, entra, google or oidc.  Dex reaches it through
# the egress proxy; PORTIKUS_EGRESS_EXTRA_HOSTS adds hosts.
PORTIKUS_IDP ?= dex
# The retired Dex users file, kept on this machine and never copied to the VM
# except for the one-time import into Dex's storage (docs/archive/epics/EPIC-14.md ruling 23).
# The Users view manages Dex accounts now.
PORTIKUS_USERS_FILE ?= $(HOME)/.config/portikus/users.json

# The connector settings, exported as they are, so an LDAP filter's
# parentheses and the two secrets never pass through a recipe line, where
# make's echo and ps would show them.
export PORTIKUS_ENTRA_TENANT_ID PORTIKUS_GOOGLE_DOMAINS PORTIKUS_EGRESS_EXTRA_HOSTS
export PORTIKUS_DEX_UPSTREAM PORTIKUS_DEX_UPSTREAM_CLIENT_ID PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET
export PORTIKUS_DEX_UPSTREAM_ISSUER PORTIKUS_OIDC_UPSTREAM_GROUPS_CLAIM PORTIKUS_OIDC_UPSTREAM_EXTRA_SCOPES
export PORTIKUS_ADMIN_EMAIL
export PORTIKUS_LDAP_HOST PORTIKUS_LDAP_SCHEMA PORTIKUS_LDAP_BIND_DN PORTIKUS_LDAP_BIND_PASSWORD
export PORTIKUS_LDAP_USER_BASE_DN PORTIKUS_LDAP_USER_FILTER PORTIKUS_LDAP_GROUP_BASE_DN
export PORTIKUS_LDAP_ROOT_CA PORTIKUS_LDAP_IP_ALLOW

ANSIBLE_ENV = PORTIKUS_VM_IP=$(VM_IP) PORTIKUS_SSH_USER=$(SSH_USER) PORTIKUS_MANAGEMENT_CIDR=$(MANAGEMENT_CIDR) \
	PORTIKUS_STORAGE=$(PORTIKUS_STORAGE) PORTIKUS_STORAGE_CONFIRM=$(PORTIKUS_STORAGE_CONFIRM) \
	PORTIKUS_IMAGE_VERSION=$(PORTIKUS_IMAGE_VERSION) \
	PORTIKUS_VERSION=$(PORTIKUS_VERSION) PORTIKUS_DEB=$(PORTIKUS_DEB_ABS) \
	PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
	PORTIKUS_IDP=$(PORTIKUS_IDP) \
	PORTIKUS_USERS_FILE="$(abspath $(PORTIKUS_USERS_FILE))" \
	PORTIKUS_OIDC_SCOPES="$(PORTIKUS_OIDC_SCOPES)" \
	PORTIKUS_OIDC_STUDENT_GROUP=$(PORTIKUS_OIDC_STUDENT_GROUP) \
	PORTIKUS_OIDC_ADMIN_GROUP=$(PORTIKUS_OIDC_ADMIN_GROUP) \
	PORTIKUS_OIDC_INSTRUCTOR_GROUP=$(PORTIKUS_OIDC_INSTRUCTOR_GROUP) \
	PORTIKUS_API_IP_ALLOW="$(PORTIKUS_API_IP_ALLOW)" \
	PORTIKUS_LTI_PLATFORMS_FILE="$(abspath $(PORTIKUS_LTI_PLATFORMS_FILE))"

configure-vm: wait-vm ## Run Ansible to converge the platform VM (newest release; PORTIKUS_VERSION=<ver> rolls back, PORTIKUS_DEB=<path> installs a local build, PORTIKUS_PUBLIC_HOST=<name> names the site, PORTIKUS_PUBLIC_PORT=<port> the port it is served on, PORTIKUS_IDP=dex|mock picks the sign-in provider, PORTIKUS_DEX_UPSTREAM=none|ldap|entra|google|oidc connects an institution's provider to Dex, PORTIKUS_USERS_FILE=<path> the users file imported once into Dex)
	cd infra/ansible && $(ANSIBLE_ENV) ansible-playbook site.yml

# ── LTI launch (docs/archive/epics/EPIC-13.md, rulings 14 and 26) ────────────────
# The registered LMS platforms. Kept on this machine; configure-vm copies it to
# the VM, and no file means LTI is off.
PORTIKUS_LTI_PLATFORMS_FILE ?= $(HOME)/.config/portikus/lti-platforms.json
# The mock LMS runs on this host, never on the VM. Its URL must be reachable by
# the user's browser (login redirect) and by the API on the VM (keyset fetch), so
# it defaults to the host's LAN address, the same one the public site uses.
MOCK_LMS_PORT ?= 8765
MOCK_LMS_HOST ?= $(HOST_IP)
MOCK_LMS_URL = http://$(MOCK_LMS_HOST):$(MOCK_LMS_PORT)
# The host's first address on the VM network, 10.100.0.1 for the pilot.
MOCK_LMS_BRIDGE_IP ?= $(or $(shell python3 -c 'import ipaddress, sys; print(next(ipaddress.ip_network(sys.argv[1]).hosts()))' '$(MANAGEMENT_CIDR)' 2>/dev/null),10.100.0.1)
MOCK_LMS_BIND ?= 127.0.0.1 $(MOCK_LMS_BRIDGE_IP) $(MOCK_LMS_HOST)
PORTIKUS_PUBLIC_URL = https://$(PORTIKUS_PUBLIC_HOST)$(if $(filter 443,$(PORTIKUS_PUBLIC_PORT)),,:$(PORTIKUS_PUBLIC_PORT))
LTI_MOCK_CLI = python3 infra/host/lti-mock-registration.py --file "$(abspath $(PORTIKUS_LTI_PLATFORMS_FILE))"

mock-lms: ## Run the mock LMS on this host in the foreground at the LAN address (MOCK_LMS_HOST, MOCK_LMS_BIND, MOCK_LMS_PORT); it is trusted only while lti-mock-register is in effect
	pnpm --dir packages/mock-lms start -- --tool-url $(PORTIKUS_PUBLIC_URL) --port $(MOCK_LMS_PORT) \
		$(foreach bind,$(MOCK_LMS_BIND),--bind $(bind)) --issuer $(MOCK_LMS_URL)

lti-mock-register: wait-vm ## Trust the mock LMS on the VM: add its registration to the platforms file and apply only the LTI tasks
	$(LTI_MOCK_CLI) register --url $(MOCK_LMS_URL)
	cd infra/ansible && $(ANSIBLE_ENV) ansible-playbook site.yml --tags lti

lti-mock-unregister: wait-vm ## Stop trusting the mock LMS: remove its registration and apply only the LTI tasks
	$(LTI_MOCK_CLI) unregister
	cd infra/ansible && $(ANSIBLE_ENV) ansible-playbook site.yml --tags lti

smoke-test: ## Run infrastructure smoke tests against the VM (PORTIKUS_PUBLIC_HOST=<name> and PORTIKUS_PUBLIC_PORT=<port> if the site was configured with them; PORTIKUS_IDP=<provider> as configured; PORTIKUS_SMOKE_SIGNIN_FILE=<file> for a full Dex sign-in)
	$(REQUIRE_VM_IP)
	PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
		PORTIKUS_IDP=$(PORTIKUS_IDP) PORTIKUS_SSH_USER=$(SSH_USER) PORTIKUS_SMOKE_SIGNIN_FILE=$(PORTIKUS_SMOKE_SIGNIN_FILE) \
		bash infra/tests/smoke-test.sh $(VM_IP)

# Safe on the live pilot: it creates and removes only its own users and two
# workspaces, and fails if anything else changed (infra/README.md, "Security test").
security-test: ## Run the VM security suite (SWEEP=1 removes leftovers of an earlier run; PORTIKUS_SECURITY_HEAVY=1 adds heavy limit tests on an otherwise empty VM; PORTIKUS_IDP=<provider> as configured)
	$(REQUIRE_VM_IP)
	PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
		PORTIKUS_IDP=$(PORTIKUS_IDP) PORTIKUS_SSH_USER=$(SSH_USER) PORTIKUS_SECURITY_HEAVY=$(PORTIKUS_SECURITY_HEAVY) \
		bash infra/tests/security-test.sh $(VM_IP) $(if $(SWEEP),--sweep,)

destroy-pilot: ## Destroy the pilot VM (irreversible), and forget its SSH host key in ~/.ssh/known_hosts
	@test "$(TOFU_ENV)" = dev-libvirt || { echo "destroy-pilot: acts on the pilot only; use make rehearsal-destroy for the rehearsal VM"; exit 1; }
	@$(MAKE) --no-print-directory TOFU_ENV=dev-libvirt TOFU_DESTROY_CALLER=destroy-pilot tofu-destroy

# Sub-makes, not prerequisites, so make -j cannot destroy the VM while the
# apply is still running.
# The pilot is apt-installed now, so the rest of a rebuild is manual.
rebuild-pilot: ## Destroy and recreate the pilot VM, then install it by hand from docs/INSTALL.md (docs/OPERATIONS.md, "The pilot")
	@$(MAKE) --no-print-directory destroy-pilot
	@$(MAKE) --no-print-directory infra-apply
	@$(MAKE) --no-print-directory publish-vm
	@echo "rebuild-pilot: the VM is empty; install Portikus on it with apt as docs/INSTALL.md describes"

publish-vm: ## Forward port 8443 from the host's LAN address to the VM (rerun after a rebuild)
	@test "$(TOFU_ENV)" = dev-libvirt || { echo "publish-vm: only the pilot is published; port 8443 belongs to it, not to $(TOFU_ENV)"; exit 1; }
	$(REQUIRE_VM_IP)
	bash infra/host/publish-vm.sh $(VM_IP)

unpublish-vm: ## Withdraw the host port forward to the VM
	bash infra/host/publish-vm.sh --remove

# ── Backup and restore (docs/adr/0024-backups-pulled-to-host.md) ──

PORTIKUS_BACKUP_DIR ?= /var/backups/portikus
PORTIKUS_BACKUP_IDENTITY ?= $(HOME)/.config/portikus/backup-age-key.txt
PORTIKUS_BACKUP_RECIPIENTS ?= $(HOME)/.config/portikus/backup-recipients.txt
# Signs each set (ADR 0044).  Derived from the key, so it can always be made
# again; it can sign sets but not read them.
PORTIKUS_BACKUP_MAC_KEY ?= $(HOME)/.config/portikus/backup-mac-key.txt

# Makes the age key pair and the set directory once.  Backing up needs only
# the public half; the private half belongs in a password manager, and a
# restore reads it from PORTIKUS_BACKUP_IDENTITY.
backup-setup:
	@command -v age-keygen >/dev/null || { echo "backup-setup: age is not installed (make bootstrap-host)"; exit 1; }
	@if [ ! -f "$(PORTIKUS_BACKUP_IDENTITY)" ] && [ ! -s "$(PORTIKUS_BACKUP_RECIPIENTS)" ]; then \
		install -d -m 0700 "$(dir $(PORTIKUS_BACKUP_IDENTITY))"; \
		(umask 077 && age-keygen -o "$(PORTIKUS_BACKUP_IDENTITY)" 2>/dev/null); \
		echo "backup-setup: made the backup key $(PORTIKUS_BACKUP_IDENTITY). Store it in your password manager, install it for restores from the admin page with make backup-install-key KEY=$(PORTIKUS_BACKUP_IDENTITY), then delete it from your home directory."; \
	fi
	@test -s "$(PORTIKUS_BACKUP_RECIPIENTS)" || age-keygen -y "$(PORTIKUS_BACKUP_IDENTITY)" >"$(PORTIKUS_BACKUP_RECIPIENTS)"
	@test -s "$(PORTIKUS_BACKUP_MAC_KEY)" || { \
		if [ -r "$(PORTIKUS_BACKUP_IDENTITY)" ]; then from="$(PORTIKUS_BACKUP_IDENTITY)"; run=""; \
		elif sudo -n test -s /etc/portikus-backup/age-key.txt 2>/dev/null; then from=/etc/portikus-backup/age-key.txt; run="sudo -n"; \
		else echo "backup-setup: no backup key to derive the signing key from; run make backup-install-key KEY=<path to the private key>"; exit 1; fi; \
		(umask 077 && $$run python3 infra/host/portikus-backup-mac derive "$$from" >"$(PORTIKUS_BACKUP_MAC_KEY).new") \
			&& mv "$(PORTIKUS_BACKUP_MAC_KEY).new" "$(PORTIKUS_BACKUP_MAC_KEY)" \
			&& echo "backup-setup: derived the signing key $(PORTIKUS_BACKUP_MAC_KEY) from $$from" \
			|| { rm -f "$(PORTIKUS_BACKUP_MAC_KEY).new"; exit 1; }; \
	}
	@test -w "$(PORTIKUS_BACKUP_DIR)" || sudo install -d -m 0700 -o "$$(id -un)" -g "$$(id -gn)" "$(PORTIKUS_BACKUP_DIR)"

# Only reads from the VM, so it is safe on the live pilot.
backup: backup-setup ## Pull an encrypted backup of the VM to the host (CHECK_STATE=1 also proves workspaces and settings did not change)
	$(REQUIRE_VM_IP)
	@test -n "$(TOFU_VM_NAME)" || { echo "backup: no VM name in $(TOFU_STATE); run make infra-apply first"; exit 1; }
	@echo "backup: reading from VM '$(TOFU_VM_NAME)' at $(VM_IP)"
	PORTIKUS_BACKUP_DIR=$(PORTIKUS_BACKUP_DIR) PORTIKUS_BACKUP_RECIPIENTS=$(PORTIKUS_BACKUP_RECIPIENTS) \
		PORTIKUS_BACKUP_MAC_KEY=$(PORTIKUS_BACKUP_MAC_KEY) bash infra/host/backup.sh $(if $(CHECK_STATE),--check-state,) --vm-name "$(TOFU_VM_NAME)" $(VM_IP)

# Fills in the @...@ values of the host backup units under infra/host/systemd.
BACKUP_UNIT_SED = sed -e "s|@USER@|$$(id -un)|" -e "s|@BACKUP_DIR@|$(PORTIKUS_BACKUP_DIR)|" \
	-e "s|@RECIPIENTS@|$(abspath $(PORTIKUS_BACKUP_RECIPIENTS))|" -e "s|@MAC_KEY@|$(abspath $(PORTIKUS_BACKUP_MAC_KEY))|" \
	-e "s|@VM_IP@|$(VM_IP)|" -e "s|@VM_NAME@|$(TOFU_VM_NAME)|"

# Host backup timers are for a VM set up with configure-vm. An apt-installed
# server, the pilot included, enables its own timer and would be backed up twice.
REFUSE_SELF_BACKUP = @rc=0; ssh -n -o BatchMode=yes -o ConnectTimeout=5 $(SSH_USER)@$(VM_IP) systemctl is-enabled --quiet portikus-backup.timer 2>/dev/null || rc=$$?; \
	case $$rc in \
	0) echo "$@: VM '$(TOFU_VM_NAME)' backs itself up: portikus-backup.timer is enabled on it, as on every apt-installed server, the pilot included. Host backup timers are only for a VM set up with make configure-vm (docs/OPERATIONS.md, \"Backups\"). Nothing was installed."; exit 1 ;; \
	255) echo "$@: cannot reach $(SSH_USER)@$(VM_IP) over SSH to check whether it backs itself up; nothing was installed"; exit 1 ;; \
	esac

# The channel target refuses a VM that backs itself up and installs the
# scripts the nightly unit runs.
backup-install-timer: backup-setup ## Install the nightly 02:30 host backup timer for a VM in dev-libvirt set up with configure-vm; refuses an apt-installed server such as the pilot, which backs itself up
	@test "$(TOFU_ENV)" = dev-libvirt || { echo "backup-install-timer: the timer backs up the pilot only"; exit 1; }
	$(REQUIRE_VM_IP)
	@test -n "$(TOFU_VM_NAME)" || { echo "backup-install-timer: no VM name in $(TOFU_STATE); run make infra-apply first"; exit 1; }
	$(MAKE) --no-print-directory backup-install-channel
	$(BACKUP_UNIT_SED) \
		infra/host/systemd/portikus-backup.service | sudo tee /etc/systemd/system/portikus-backup.service >/dev/null
	sudo install -m 0644 infra/host/systemd/portikus-backup.timer /etc/systemd/system/portikus-backup.timer
	sudo systemctl daemon-reload
	sudo systemctl enable --now portikus-backup.timer
	systemctl list-timers portikus-backup.timer --no-pager

# The admin page's requests (docs/adr/0039-backup-channel-and-host-held-key.md).
# One channel per host, for workstation-deployed VMs only; the apt-installed
# pilot runs its own channel. Installing it for the rehearsal VM repoints it there.
backup-install-channel: backup-setup ## Install the host timer that runs backup requests from the admin page, for a VM in TOFU_ENV set up with configure-vm; refuses an apt-installed server such as the pilot
	$(REQUIRE_VM_IP)
	@test -n "$(TOFU_VM_NAME)" || { echo "backup-install-channel: no VM name in $(TOFU_STATE); run make infra-apply first"; exit 1; }
	$(REFUSE_SELF_BACKUP)
	sudo install -m 0755 infra/host/backup.sh /usr/local/sbin/portikus-backup
	sudo install -m 0644 infra/host/portikus-backup-export /usr/local/sbin/portikus-backup-export
	sudo install -m 0644 infra/host/portikus-backup-mac /usr/local/sbin/portikus-backup-mac
	sudo install -m 0644 infra/host/portikus-backup-lib.sh /usr/local/sbin/portikus-backup-lib.sh
	sudo install -m 0755 infra/host/backup-channel.sh /usr/local/sbin/portikus-backup-channel
	sudo install -m 0755 infra/host/restore-copy.sh /usr/local/sbin/portikus-restore-copy
	$(BACKUP_UNIT_SED) \
		-e "s|@NIGHTLY@|$(if $(filter dev-libvirt,$(TOFU_ENV)),portikus-backup,)|" \
		infra/host/systemd/portikus-backup-channel.service | sudo tee /etc/systemd/system/portikus-backup-channel.service >/dev/null
	sudo install -m 0644 infra/host/systemd/portikus-backup-channel.timer /etc/systemd/system/portikus-backup-channel.timer
	sudo systemctl daemon-reload
	sudo systemctl enable --now portikus-backup-channel.timer
	systemctl list-timers portikus-backup-channel.timer --no-pager

# Root-only on the host, so restores from the admin page can read the sets;
# whoever takes the host can then read every backup (ADR 0039).
backup-install-key: ## Install the private backup key root-only at /etc/portikus-backup/age-key.txt (KEY=<path>)
	@test -n "$(KEY)" && test -s "$(KEY)" || { echo "backup-install-key: KEY=<path to the private age key> is required"; exit 1; }
	@test -s "$(PORTIKUS_BACKUP_RECIPIENTS)" || { echo "backup-install-key: no recipients file at $(PORTIKUS_BACKUP_RECIPIENTS) to check the key against"; exit 1; }
	@pub=$$(age-keygen -y "$(KEY)") && grep -qxF "$$pub" "$(PORTIKUS_BACKUP_RECIPIENTS)" \
		|| { echo "backup-install-key: $(KEY) is not the key backups are encrypted to ($(PORTIKUS_BACKUP_RECIPIENTS)); nothing installed"; exit 1; }
	sudo install -d -m 0700 -o root -g root /etc/portikus-backup
	sudo install -m 0600 -o root -g root "$(KEY)" /etc/portikus-backup/age-key.txt
	(umask 077 && python3 infra/host/portikus-backup-mac derive "$(KEY)" >"$(PORTIKUS_BACKUP_MAC_KEY).new") && mv "$(PORTIKUS_BACKUP_MAC_KEY).new" "$(PORTIKUS_BACKUP_MAC_KEY)"
	@echo "backup-install-key: installed /etc/portikus-backup/age-key.txt (root, 0600). Keep your password-manager copy and delete $(KEY) if it is in your home directory."

# Replaces the target's database, so it refuses the pilot's environment, and
# restore.sh refuses any VM whose hostname is not the one in the state.
restore: ## Restore a backup set onto the rehearsal VM (TOFU_ENV=rehearsal-libvirt BACKUP=/var/backups/portikus/<vm name>/<timestamp>; START_CHECK=1 starts one workspace and checks it; REMOVE=1 deletes the restored data afterwards)
	$(TOFU_BANNER)
	@test "$(TOFU_ENV)" != dev-libvirt || { echo "restore: refuses the pilot environment; pass TOFU_ENV=rehearsal-libvirt"; exit 1; }
	@test -n "$(BACKUP)" || { echo "restore: BACKUP=<set dir> is required, e.g. $(PORTIKUS_BACKUP_DIR)/<vm name>/<timestamp>"; exit 1; }
	$(call REQUIRE_VM_IP,rehearsal-up)
	PORTIKUS_BACKUP_IDENTITY=$(PORTIKUS_BACKUP_IDENTITY) \
		bash infra/host/restore.sh $(if $(START_CHECK),--start-check,) $(if $(REMOVE),--remove,) --target-name "$(TOFU_VM_NAME)" $(VM_IP) $(BACKUP)

# ── Application deployment targets ────────────────────────────────

build-deb: ## Build the control-plane Debian package into dist/deb
	pnpm build:deb

install-screens: ## Capture the install screens in docs/INSTALL.md as PNGs under docs/images/install (needs Docker, Pillow, optipng)
	packaging/tests/capture-install-screens.sh

# Installing the package restarts the services and runs the migrations from the
# API unit's ExecStartPre (ADR 0007).
deploy-app: ## Build the Debian package and install it on the VM
	$(REQUIRE_VM_IP)
	@set -e; \
	pnpm build:deb; \
	version="$$(cat dist/deb/VERSION)"; \
	deb="portikus_$${version}_amd64.deb"; \
	echo "Installing $$deb on $(VM_IP)"; \
	scp "dist/deb/$$deb" $(SSH_USER)@$(VM_IP):"~/"; \
	ssh -n $(SSH_USER)@$(VM_IP) "sudo apt-get install -y --reinstall --allow-downgrades ./$$deb; rm -f ./$$deb"

# ── Workspace image and lifecycle targets ─────────────────────────

# The image job builds the recipe the installed package ships, so a recipe
# that differs from the checkout's is refused rather than built stale.
build-workspace-image: ## Build the workspace image on the VM with the image job and make it the default (after make deploy-app)
	$(REQUIRE_VM_IP)
	@here="$$(cd infra/workspace-image && sha256sum portikus.yaml VERSION)"; \
	there="$$(ssh -n $(SSH_USER)@$(VM_IP) 'cd /usr/share/portikus/workspace-image && sha256sum portikus.yaml VERSION')"; \
	test "$$here" = "$$there" || { echo "build-workspace-image: the package on $(VM_IP) ships a different image recipe from this checkout; run make deploy-app first"; exit 1; }
	rsync -av --delete infra/incus/ $(SSH_USER)@$(VM_IP):/var/lib/portikus/incus/
	ssh -n $(SSH_USER)@$(VM_IP) sudo /usr/lib/portikus/image-job local-build

workspace-create: ## Create a test workspace (NAME=<name>)
	@test -n "$(NAME)" || { echo "workspace-create: NAME is required, e.g. make workspace-create NAME=alice"; exit 1; }
	$(REQUIRE_VM_IP)
	ssh -n $(SSH_USER)@$(VM_IP) bash /var/lib/portikus/incus/workspace.sh create $(NAME)

workspace-destroy: ## Destroy a test workspace (NAME=<name>)
	@test -n "$(NAME)" || { echo "workspace-destroy: NAME is required, e.g. make workspace-destroy NAME=alice"; exit 1; }
	$(REQUIRE_VM_IP)
	ssh -n $(SSH_USER)@$(VM_IP) bash /var/lib/portikus/incus/workspace.sh destroy $(NAME)

# Fragments that add targets of their own (load test, rebuild exercise).
-include mk/*.mk
