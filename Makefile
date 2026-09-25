# Documented operator entry point (STACK.md section 31).
# Every target is a thin wrapper over a tool that stays usable on its own.

.PHONY: help install check typecheck lint format test test-coverage build test-e2e dev clean \
       infra-check bootstrap-host wait-vm infra-plan infra-apply configure-vm smoke-test security-test destroy-pilot rebuild-pilot \
       publish-vm unpublish-vm rehearsal-up rehearsal-destroy rehearsal-preflight tofu-destroy \
       build-deb deploy-app build-workspace-image workspace-create workspace-destroy \
       backup-setup backup backup-install-timer restore \
       mock-lms lti-mock-register lti-mock-unregister

help: ## Show the available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install workspace dependencies from the lockfile
	pnpm install --frozen-lockfile

check: typecheck lint test-coverage build infra-check ## Run every repository check, including the infrastructure checks CI runs

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
# Its accounts come from a restored dex.dump or /setup, never the pilot's
# retired users file, whose import would make restore.sh refuse the VM.
# An exported PORTIKUS_USERS_FILE does not override this; the command line does.
PORTIKUS_USERS_FILE := /nonexistent
else
$(error TOFU_ENV must be dev-libvirt or rehearsal-libvirt, not '$(TOFU_ENV)')
endif

# Read straight from the state file, so no `tofu init` is needed to learn it.
tofu_output = $(shell python3 -c 'import json, sys; v = json.load(open(sys.argv[1]))["outputs"][sys.argv[2]]["value"]; print(v[0] if isinstance(v, list) else v)' '$(TOFU_STATE)' $(1) 2>/dev/null)
TOFU_VM_NAME = $(call tofu_attr,libvirt_domain,vm,name)
# A replaced VM keeps its MAC address, which its network configuration matches.
export TF_VAR_mac_address = $(call tofu_attr,libvirt_domain,vm,network_interface.0.mac)

# First recipe line of every OpenTofu target: name the VM, and never let a
# non-pilot environment act on a state file that holds the pilot.
TOFU_BANNER = @echo "$@: OpenTofu environment $(TOFU_ENV), state $(TOFU_STATE), VM '$(or $(TOFU_VM_NAME),<none yet>)'"; \
	test "$(TOFU_ENV)" = dev-libvirt || test "$(TOFU_VM_NAME)" != portikus || { echo "$@: that state holds the pilot VM; refusing"; exit 1; }

rehearsal-up: ## Create or update the rehearsal VM beside the pilot and wait for it (REHEARSAL_VCPUS, REHEARSAL_MEMORY_MB, REHEARSAL_DATA_DISK_GB size it)
	@$(MAKE) --no-print-directory TOFU_ENV=rehearsal-libvirt rehearsal-preflight infra-apply wait-vm

rehearsal-destroy: ## Destroy the rehearsal VM, its disks, network and pool (never the pilot)
	@$(MAKE) --no-print-directory TOFU_ENV=rehearsal-libvirt TOFU_DESTROY_CALLER=rehearsal-destroy tofu-destroy

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
tofu-destroy:
	@test -n "$(TOFU_DESTROY_CALLER)" || { echo "tofu-destroy: use make destroy-pilot or make rehearsal-destroy"; exit 1; }
	$(TOFU_BANNER)
	cd $(TOFU_DIR) && tofu init -input=false $(TOFU_INIT_ARGS) && tofu destroy

# Mirrors the "Infrastructure checks" job in .github/workflows/ci.yml.
infra-check: ## Run the infrastructure checks CI runs: tofu fmt/validate, ansible-lint, shellcheck
	@for t in tofu ansible-lint ansible-galaxy shellcheck; do \
		command -v $$t >/dev/null || { echo "infra-check: $$t is not installed (see docs/WORKFLOW.md, Local development)"; exit 1; }; \
	done
	tofu fmt -check -recursive infra/tofu
	for env in dev-libvirt rehearsal-libvirt; do \
		(cd infra/tofu/environments/$$env && tofu init -backend=false -input=false >/dev/null && tofu validate) || exit 1; \
	done
	ansible-galaxy collection install --force -r infra/ansible/requirements.yml
	ansible-lint infra/ansible
	find . -name '*.sh' -not -path './node_modules/*' -not -path './dist/*' -not -path './.claude/*' -print0 | xargs -0 shellcheck && shellcheck packaging/scripts/* infra/host/portikus-backup-export
	bash infra/tests/cleanup-scope-test.sh
	bash infra/tests/security-cleanup-scope-test.sh
	bash infra/tests/clipboard-shim-test.sh
	bash infra/tests/caddy-preview-test.sh
	bash infra/tests/lti-platforms-test.sh
	ansible-playbook infra/tests/dex-render-test.yml
	ansible-playbook infra/tests/egress-proxy-render-test.yml
	bash infra/tests/backup-scope-test.sh

bootstrap-host: ## Install host prerequisites (KVM, libvirt, OpenTofu, Ansible, age, SOPS)
	bash infra/host/dev-libvirt/bootstrap.sh

infra-plan: ## Show what OpenTofu would change in the platform VM
	$(TOFU_BANNER)
	cd $(TOFU_DIR) && tofu init -input=false $(TOFU_INIT_ARGS) && tofu plan

infra-apply: ## Create or update the platform VM and disks (TOFU_ENV=rehearsal-libvirt for the rehearsal VM)
	$(TOFU_BANNER)
	cd $(TOFU_DIR) && tofu init -input=false $(TOFU_INIT_ARGS) && tofu apply

# The VM address comes from OpenTofu state; override with VM_IP=<ip>.
VM_IP ?= $(call tofu_output,vm_ip)
MANAGEMENT_CIDR ?= $(call tofu_output,management_cidr)

# The host's own LAN address, taken from its default route.
HOST_IP ?= $(shell ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($$i == "src") { print $$(i + 1); exit }}')

# The site name the VM's Caddy serves. It has to be the host's address, not the
# VM's, because LAN browsers reach the VM through the host port forward.
PORTIKUS_PUBLIC_HOST ?= portikus.$(HOST_IP).nip.io

# The port browsers connect to. The host keeps 80 and 443 for another
# service, so Caddy on the VM serves the site on 8443 and the host forwards
# that port straight through.
PORTIKUS_PUBLIC_PORT ?= 8443

# Block until the VM answers SSH and cloud-init has finished, so Ansible does
# not race the first-boot apt update. The known-hosts options are for the wait
# only: a rebuilt VM has a new host key at the same address.
wait-vm: ## Wait for the platform VM to finish first boot
	@test -n "$(VM_IP)" || { echo "wait-vm: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	@for i in $$(seq 1 60); do \
		ssh -n -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
			-o LogLevel=ERROR deploy@$(VM_IP) 'cloud-init status --wait >/dev/null 2>&1; cloud-init status' 2>/dev/null && exit 0; \
		sleep 5; \
	done; echo "wait-vm: $(VM_IP) did not become ready"; exit 1

# Ansible runs from infra/ansible, so a local package path has to be absolute.
PORTIKUS_DEB_ABS := $(if $(PORTIKUS_DEB),$(abspath $(PORTIKUS_DEB)),)

# ── Sign-in provider and accounts (docs/adr/0023) ──────────────────
# PORTIKUS_IDP picks the provider: dex (the default), entra, google, external
# (any other OIDC provider named by the PORTIKUS_OIDC_* settings), or mock
# (test only: anyone can sign in as anyone).  The API reaches an outside
# provider through the egress proxy; PORTIKUS_EGRESS_EXTRA_HOSTS adds hosts.
PORTIKUS_IDP ?= dex
# The retired Dex users file, kept on this machine and never copied to the VM
# except for the one-time import into Dex's storage (docs/archive/epics/EPIC-14.md ruling 23).
# The Users view manages Dex accounts now.
PORTIKUS_USERS_FILE ?= $(HOME)/.config/portikus/users.json

# The client secret reaches Ansible through the environment, never a recipe
# line, where make's echo and ps would show it.
export PORTIKUS_OIDC_CLIENT_SECRET
# The provider settings of docs/archive/epics/EPIC-14.md, exported as they are, so an LDAP
# filter's parentheses and the two secrets never pass through a recipe line.
export PORTIKUS_ENTRA_TENANT_ID PORTIKUS_GOOGLE_DOMAINS PORTIKUS_EGRESS_EXTRA_HOSTS
export PORTIKUS_DEX_UPSTREAM PORTIKUS_DEX_UPSTREAM_CLIENT_ID PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET
export PORTIKUS_LDAP_HOST PORTIKUS_LDAP_SCHEMA PORTIKUS_LDAP_BIND_DN PORTIKUS_LDAP_BIND_PASSWORD
export PORTIKUS_LDAP_USER_BASE_DN PORTIKUS_LDAP_USER_FILTER PORTIKUS_LDAP_GROUP_BASE_DN
export PORTIKUS_LDAP_ROOT_CA PORTIKUS_LDAP_IP_ALLOW

ANSIBLE_ENV = PORTIKUS_VM_IP=$(VM_IP) PORTIKUS_MANAGEMENT_CIDR=$(MANAGEMENT_CIDR) \
	PORTIKUS_VERSION=$(PORTIKUS_VERSION) PORTIKUS_DEB=$(PORTIKUS_DEB_ABS) \
	PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
	PORTIKUS_IDP=$(PORTIKUS_IDP) PORTIKUS_MOCK_IDP=$(PORTIKUS_MOCK_IDP) \
	PORTIKUS_USERS_FILE="$(abspath $(PORTIKUS_USERS_FILE))" \
	PORTIKUS_OIDC_ISSUER=$(PORTIKUS_OIDC_ISSUER) PORTIKUS_OIDC_CLIENT_ID=$(PORTIKUS_OIDC_CLIENT_ID) \
	PORTIKUS_OIDC_SCOPES="$(PORTIKUS_OIDC_SCOPES)" \
	PORTIKUS_OIDC_STUDENT_GROUP=$(PORTIKUS_OIDC_STUDENT_GROUP) \
	PORTIKUS_OIDC_ADMIN_GROUP=$(PORTIKUS_OIDC_ADMIN_GROUP) \
	PORTIKUS_OIDC_INSTRUCTOR_GROUP=$(PORTIKUS_OIDC_INSTRUCTOR_GROUP) \
	PORTIKUS_API_IP_ALLOW="$(PORTIKUS_API_IP_ALLOW)" \
	PORTIKUS_LTI_PLATFORMS_FILE="$(abspath $(PORTIKUS_LTI_PLATFORMS_FILE))"

configure-vm: wait-vm ## Run Ansible to converge the platform VM (newest release; PORTIKUS_VERSION=<ver> rolls back, PORTIKUS_DEB=<path> installs a local build, PORTIKUS_PUBLIC_HOST=<name> names the site, PORTIKUS_PUBLIC_PORT=<port> the port it is served on, PORTIKUS_IDP=dex|entra|google|external|mock picks the sign-in provider, PORTIKUS_USERS_FILE=<path> the users file imported once into Dex)
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
	@test -n "$(VM_IP)" || { echo "smoke-test: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
		PORTIKUS_IDP=$(PORTIKUS_IDP) PORTIKUS_SMOKE_SIGNIN_FILE=$(PORTIKUS_SMOKE_SIGNIN_FILE) \
		bash infra/tests/smoke-test.sh $(VM_IP)

# Safe on the live pilot: it creates and removes only its own users and two
# workspaces, and fails if anything else changed (infra/README.md, "Security test").
security-test: ## Run the VM security suite (SWEEP=1 removes leftovers of an earlier run; PORTIKUS_SECURITY_HEAVY=1 adds heavy limit tests on an otherwise empty VM; PORTIKUS_IDP=<provider> as configured)
	@test -n "$(VM_IP)" || { echo "security-test: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
		PORTIKUS_IDP=$(PORTIKUS_IDP) PORTIKUS_SECURITY_HEAVY=$(PORTIKUS_SECURITY_HEAVY) \
		bash infra/tests/security-test.sh $(VM_IP) $(if $(SWEEP),--sweep,)

destroy-pilot: ## Destroy the pilot VM (irreversible)
	@test "$(TOFU_ENV)" = dev-libvirt || { echo "destroy-pilot: acts on the pilot only; use make rehearsal-destroy for the rehearsal VM"; exit 1; }
	@$(MAKE) --no-print-directory TOFU_ENV=dev-libvirt TOFU_DESTROY_CALLER=destroy-pilot tofu-destroy

# Sub-makes, not prerequisites, so make -j cannot destroy the VM while the
# apply is still running.
rebuild-pilot: ## Destroy and recreate the platform VM
	@$(MAKE) --no-print-directory destroy-pilot
	@$(MAKE) --no-print-directory infra-apply
	@$(MAKE) --no-print-directory configure-vm
	@$(MAKE) --no-print-directory publish-vm

publish-vm: ## Forward port 8443 from the host's LAN address to the VM (rerun after a rebuild)
	@test "$(TOFU_ENV)" = dev-libvirt || { echo "publish-vm: only the pilot is published; port 8443 belongs to it, not to $(TOFU_ENV)"; exit 1; }
	@test -n "$(VM_IP)" || { echo "publish-vm: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	bash infra/host/publish-vm.sh $(VM_IP)

unpublish-vm: ## Withdraw the host port forward to the VM
	bash infra/host/publish-vm.sh --remove

# ── Backup and restore (docs/adr/0024-backups-pulled-to-host.md) ──

PORTIKUS_BACKUP_DIR ?= /var/backups/portikus
PORTIKUS_BACKUP_IDENTITY ?= $(HOME)/.config/portikus/backup-age-key.txt
PORTIKUS_BACKUP_RECIPIENTS ?= $(HOME)/.config/portikus/backup-recipients.txt

# Makes the age key pair and the set directory once.  Backing up needs only
# the public half; the private half belongs in a password manager, and a
# restore reads it from PORTIKUS_BACKUP_IDENTITY.
backup-setup:
	@command -v age-keygen >/dev/null || { echo "backup-setup: age is not installed (make bootstrap-host)"; exit 1; }
	@if [ ! -f "$(PORTIKUS_BACKUP_IDENTITY)" ] && [ ! -s "$(PORTIKUS_BACKUP_RECIPIENTS)" ]; then \
		install -d -m 0700 "$(dir $(PORTIKUS_BACKUP_IDENTITY))"; \
		(umask 077 && age-keygen -o "$(PORTIKUS_BACKUP_IDENTITY)" 2>/dev/null); \
		echo "backup-setup: made the backup key $(PORTIKUS_BACKUP_IDENTITY). Store it in your password manager, then remove it from this host: backups need only the public half, and without the private half no backup can be read."; \
	fi
	@test -s "$(PORTIKUS_BACKUP_RECIPIENTS)" || age-keygen -y "$(PORTIKUS_BACKUP_IDENTITY)" >"$(PORTIKUS_BACKUP_RECIPIENTS)"
	@test -w "$(PORTIKUS_BACKUP_DIR)" || sudo install -d -m 0700 -o "$$(id -un)" -g "$$(id -gn)" "$(PORTIKUS_BACKUP_DIR)"

# Only reads from the VM, so it is safe on the live pilot.
backup: backup-setup ## Pull an encrypted backup of the VM to the host (CHECK_STATE=1 also proves workspaces and settings did not change)
	@test -n "$(VM_IP)" || { echo "backup: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	@test -n "$(TOFU_VM_NAME)" || { echo "backup: no VM name in $(TOFU_STATE); run make infra-apply first"; exit 1; }
	@echo "backup: reading from VM '$(TOFU_VM_NAME)' at $(VM_IP)"
	PORTIKUS_BACKUP_DIR=$(PORTIKUS_BACKUP_DIR) PORTIKUS_BACKUP_RECIPIENTS=$(PORTIKUS_BACKUP_RECIPIENTS) \
		bash infra/host/backup.sh $(if $(CHECK_STATE),--check-state,) --vm-name "$(TOFU_VM_NAME)" $(VM_IP)

backup-install-timer: backup-setup ## Install the nightly 02:30 backup of the pilot as a host systemd timer (rerun after changing backup.sh)
	@test "$(TOFU_ENV)" = dev-libvirt || { echo "backup-install-timer: the timer backs up the pilot only"; exit 1; }
	@test -n "$(VM_IP)" || { echo "backup-install-timer: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	@test -n "$(TOFU_VM_NAME)" || { echo "backup-install-timer: no VM name in $(TOFU_STATE); run make infra-apply first"; exit 1; }
	sudo install -m 0755 infra/host/backup.sh /usr/local/sbin/portikus-backup
	sudo install -m 0644 infra/host/portikus-backup-export /usr/local/sbin/portikus-backup-export
	sed -e "s|@USER@|$$(id -un)|" -e "s|@BACKUP_DIR@|$(PORTIKUS_BACKUP_DIR)|" \
		-e "s|@RECIPIENTS@|$(abspath $(PORTIKUS_BACKUP_RECIPIENTS))|" -e "s|@VM_IP@|$(VM_IP)|" -e "s|@VM_NAME@|$(TOFU_VM_NAME)|" \
		infra/host/systemd/portikus-backup.service | sudo tee /etc/systemd/system/portikus-backup.service >/dev/null
	sudo install -m 0644 infra/host/systemd/portikus-backup.timer /etc/systemd/system/portikus-backup.timer
	sudo systemctl daemon-reload
	sudo systemctl enable --now portikus-backup.timer
	systemctl list-timers portikus-backup.timer --no-pager

# Replaces the target's database, so it refuses the pilot's environment, and
# restore.sh refuses any VM whose hostname is not the one in the state.
restore: ## Restore a backup set onto the rehearsal VM (TOFU_ENV=rehearsal-libvirt BACKUP=/var/backups/portikus/<vm name>/<timestamp>; START_CHECK=1 starts one workspace and checks it; REMOVE=1 deletes the restored data afterwards)
	$(TOFU_BANNER)
	@test "$(TOFU_ENV)" != dev-libvirt || { echo "restore: refuses the pilot environment; pass TOFU_ENV=rehearsal-libvirt"; exit 1; }
	@test -n "$(BACKUP)" || { echo "restore: BACKUP=<set dir> is required, e.g. $(PORTIKUS_BACKUP_DIR)/<vm name>/<timestamp>"; exit 1; }
	@test -n "$(VM_IP)" || { echo "restore: no VM address; run make rehearsal-up first or pass VM_IP=<ip>"; exit 1; }
	PORTIKUS_BACKUP_IDENTITY=$(PORTIKUS_BACKUP_IDENTITY) \
		bash infra/host/restore.sh $(if $(START_CHECK),--start-check,) $(if $(REMOVE),--remove,) --target-name "$(TOFU_VM_NAME)" $(VM_IP) $(BACKUP)

# ── Application deployment targets ────────────────────────────────

build-deb: ## Build the control-plane Debian package into dist/deb
	pnpm build:deb

# Installing the package restarts the services and runs the migrations from the
# API unit's ExecStartPre (ADR 0007).
deploy-app: ## Build the Debian package and install it on the VM
	@test -n "$(VM_IP)" || { echo "deploy-app: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	@set -e; \
	pnpm build:deb; \
	version="$$(cat dist/deb/VERSION)"; \
	deb="portikus_$${version}_amd64.deb"; \
	echo "Installing $$deb on $(VM_IP)"; \
	scp "dist/deb/$$deb" deploy@$(VM_IP):"~/"; \
	ssh -n deploy@$(VM_IP) "sudo apt-get install -y --reinstall --allow-downgrades ./$$deb; rm -f ./$$deb"

# ── Workspace image and lifecycle targets ─────────────────────────

build-workspace-image: ## Build the workspace image on the VM with distrobuilder
	@test -n "$(VM_IP)" || { echo "build-workspace-image: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	rsync -av --delete infra/workspace-image/ deploy@$(VM_IP):/var/lib/portikus/image-build/
	rsync -av --delete infra/incus/ deploy@$(VM_IP):/var/lib/portikus/incus/
	ssh -n deploy@$(VM_IP) bash /var/lib/portikus/image-build/build-on-vm.sh

workspace-create: ## Create a test workspace (NAME=<name>)
	@test -n "$(NAME)" || { echo "workspace-create: NAME is required, e.g. make workspace-create NAME=alice"; exit 1; }
	@test -n "$(VM_IP)" || { echo "workspace-create: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	ssh -n deploy@$(VM_IP) bash /var/lib/portikus/incus/workspace.sh create $(NAME)

workspace-destroy: ## Destroy a test workspace (NAME=<name>)
	@test -n "$(NAME)" || { echo "workspace-destroy: NAME is required, e.g. make workspace-destroy NAME=alice"; exit 1; }
	@test -n "$(VM_IP)" || { echo "workspace-destroy: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	ssh -n deploy@$(VM_IP) bash /var/lib/portikus/incus/workspace.sh destroy $(NAME)

# Fragments that add targets of their own (load test, rebuild exercise).
-include mk/*.mk
