# Documented operator entry point (STACK.md section 31).
# Every target is a thin wrapper over a tool that stays usable on its own.

.PHONY: help install check typecheck lint format test test-coverage build test-e2e dev clean \
       infra-check bootstrap-host wait-vm infra-plan infra-apply configure-vm smoke-test security-test destroy-pilot rebuild-pilot \
       publish-vm unpublish-vm rehearsal-up rehearsal-destroy rehearsal-preflight tofu-destroy \
       build-deb deploy-app build-workspace-image workspace-create workspace-destroy \
       users-add users-remove users-list users-check users-deploy identity-carry-over-dry-run \
       backup-setup backup backup-install-timer restore

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
# rehearsal-libvirt the throwaway VM beside it (docs/EPIC-12B.md).
TOFU_ENV ?= dev-libvirt
TOFU_DIR := infra/tofu/environments/$(TOFU_ENV)

# The rehearsal state lives outside the repository so every worktree shares it.
REHEARSAL_STATE ?= $(HOME)/.local/state/portikus/rehearsal-libvirt/terraform.tfstate
REHEARSAL_SSH_KEY ?= $(HOME)/.ssh/id_ed25519.pub
REHEARSAL_VCPUS ?= 12
REHEARSAL_MEMORY_MB ?= 24576

ifeq ($(TOFU_ENV),dev-libvirt)
TOFU_STATE := $(TOFU_DIR)/terraform.tfstate
TOFU_INIT_ARGS :=
else ifeq ($(TOFU_ENV),rehearsal-libvirt)
TOFU_STATE := $(REHEARSAL_STATE)
TOFU_INIT_ARGS := -backend-config=path=$(REHEARSAL_STATE)
export TF_VAR_ssh_public_key := $(shell cat $(REHEARSAL_SSH_KEY) 2>/dev/null)
export TF_VAR_vcpus := $(REHEARSAL_VCPUS)
export TF_VAR_memory_mb := $(REHEARSAL_MEMORY_MB)
else
$(error TOFU_ENV must be dev-libvirt or rehearsal-libvirt, not '$(TOFU_ENV)')
endif

# Read straight from the state file, so no `tofu init` is needed to learn them.
tofu_output = $(shell python3 -c 'import json, sys; v = json.load(open(sys.argv[1]))["outputs"][sys.argv[2]]["value"]; print(v[0] if isinstance(v, list) else v)' '$(TOFU_STATE)' $(1) 2>/dev/null)
TOFU_VM_NAME = $(shell python3 -c 'import json, sys; print(next(r["instances"][0]["attributes"]["name"] for r in json.load(open(sys.argv[1]))["resources"] if r["type"] == "libvirt_domain"))' '$(TOFU_STATE)' 2>/dev/null)

# First recipe line of every OpenTofu target: name the VM, and never let a
# non-pilot environment act on a state file that holds the pilot.
TOFU_BANNER = @echo "$@: OpenTofu environment $(TOFU_ENV), state $(TOFU_STATE), VM '$(or $(TOFU_VM_NAME),<none yet>)'"; \
	test "$(TOFU_ENV)" = dev-libvirt || test "$(TOFU_VM_NAME)" != portikus || { echo "$@: that state holds the pilot VM; refusing"; exit 1; }

rehearsal-up: ## Create the rehearsal VM beside the pilot and wait for first boot (REHEARSAL_VCPUS, REHEARSAL_MEMORY_MB size it)
	@$(MAKE) --no-print-directory TOFU_ENV=rehearsal-libvirt rehearsal-preflight infra-apply wait-vm

rehearsal-destroy: ## Destroy the rehearsal VM, its disks, network and pool (never the pilot)
	@$(MAKE) --no-print-directory TOFU_ENV=rehearsal-libvirt tofu-destroy

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

# Only rehearsal-destroy and destroy-pilot call this; each fixes TOFU_ENV.
tofu-destroy:
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
	ansible-playbook infra/tests/dex-render-test.yml
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
# PORTIKUS_IDP picks the provider: dex (the default), mock (test only: anyone
# can sign in as anyone), or external (a real provider named by the
# PORTIKUS_OIDC_* settings, reachable through PORTIKUS_API_IP_ALLOW=<cidr>).
PORTIKUS_IDP ?= dex
# Dex accounts. Kept on this machine, outside any work tree; never on the VM.
PORTIKUS_USERS_FILE ?= $(HOME)/.config/portikus/users.json
USERS_CLI = pnpm --silent --dir packages/users-file exec tsx src/main.ts
USERS_FILE_FLAG = --file "$(abspath $(PORTIKUS_USERS_FILE))"
# The users file is needed, and checked first, only when Dex is the provider.
USERS_CHECK := $(if $(filter dex,$(PORTIKUS_IDP)),users-check,)

ANSIBLE_ENV = PORTIKUS_VM_IP=$(VM_IP) PORTIKUS_MANAGEMENT_CIDR=$(MANAGEMENT_CIDR) \
	PORTIKUS_VERSION=$(PORTIKUS_VERSION) PORTIKUS_DEB=$(PORTIKUS_DEB_ABS) \
	PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
	PORTIKUS_IDP=$(PORTIKUS_IDP) PORTIKUS_MOCK_IDP=$(PORTIKUS_MOCK_IDP) \
	PORTIKUS_USERS_FILE="$(abspath $(PORTIKUS_USERS_FILE))" \
	PORTIKUS_OIDC_ISSUER=$(PORTIKUS_OIDC_ISSUER) PORTIKUS_OIDC_CLIENT_ID=$(PORTIKUS_OIDC_CLIENT_ID) \
	PORTIKUS_OIDC_CLIENT_SECRET=$(PORTIKUS_OIDC_CLIENT_SECRET) PORTIKUS_OIDC_SCOPES="$(PORTIKUS_OIDC_SCOPES)" \
	PORTIKUS_OIDC_STUDENT_GROUP=$(PORTIKUS_OIDC_STUDENT_GROUP) \
	PORTIKUS_OIDC_ADMIN_GROUP=$(PORTIKUS_OIDC_ADMIN_GROUP) \
	PORTIKUS_API_IP_ALLOW="$(PORTIKUS_API_IP_ALLOW)"

users-add: ## Add or update a Dex account; asks for the password twice (USERNAME=<name>)
	@test -n "$(USERNAME)" || { echo "users-add: USERNAME is required, e.g. make users-add USERNAME=alice"; exit 1; }
	@$(USERS_CLI) add "$(USERNAME)" $(USERS_FILE_FLAG)

users-remove: ## Remove a Dex account (USERNAME=<name>); users-deploy applies it
	@test -n "$(USERNAME)" || { echo "users-remove: USERNAME is required, e.g. make users-remove USERNAME=alice"; exit 1; }
	@$(USERS_CLI) remove "$(USERNAME)" $(USERS_FILE_FLAG)

users-list: ## List the Dex accounts (never shows password hashes)
	@$(USERS_CLI) list $(USERS_FILE_FLAG)

users-check: ## Validate the users file
	@$(USERS_CLI) check $(USERS_FILE_FLAG)

users-deploy: users-check wait-vm ## Apply the users file to Dex on the VM
	@test "$(PORTIKUS_IDP)" = dex || { echo "users-deploy: only for PORTIKUS_IDP=dex"; exit 1; }
	cd infra/ansible && $(ANSIBLE_ENV) ansible-playbook site.yml --tags dex

identity-carry-over-dry-run: users-check wait-vm ## Show which existing accounts the move to Dex would carry over; changes nothing
	@test "$(PORTIKUS_IDP)" = dex || { echo "identity-carry-over-dry-run: only for PORTIKUS_IDP=dex"; exit 1; }
	cd infra/ansible && $(ANSIBLE_ENV) ansible-playbook site.yml --tags carry_over -e portikus_carry_over_apply=false

configure-vm: $(USERS_CHECK) wait-vm ## Run Ansible to converge the platform VM (newest release; PORTIKUS_VERSION=<ver> rolls back, PORTIKUS_DEB=<path> installs a local build, PORTIKUS_PUBLIC_HOST=<name> names the site, PORTIKUS_PUBLIC_PORT=<port> the port it is served on, PORTIKUS_IDP=dex|mock|external picks the sign-in provider, PORTIKUS_USERS_FILE=<path> the Dex accounts)
	cd infra/ansible && $(ANSIBLE_ENV) ansible-playbook site.yml

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
	@$(MAKE) --no-print-directory TOFU_ENV=dev-libvirt tofu-destroy

rebuild-pilot: destroy-pilot infra-apply configure-vm publish-vm ## Destroy and recreate the platform VM

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
	@echo "backup: reading from VM '$(or $(TOFU_VM_NAME),unknown)' at $(VM_IP)"
	PORTIKUS_BACKUP_DIR=$(PORTIKUS_BACKUP_DIR) PORTIKUS_BACKUP_RECIPIENTS=$(PORTIKUS_BACKUP_RECIPIENTS) \
		bash infra/host/backup.sh $(if $(CHECK_STATE),--check-state,) $(VM_IP)

backup-install-timer: backup-setup ## Install the nightly 02:30 backup of the pilot as a host systemd timer (rerun after changing backup.sh)
	@test "$(TOFU_ENV)" = dev-libvirt || { echo "backup-install-timer: the timer backs up the pilot only"; exit 1; }
	@test -n "$(VM_IP)" || { echo "backup-install-timer: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	sudo install -m 0755 infra/host/backup.sh /usr/local/sbin/portikus-backup
	sudo install -m 0644 infra/host/portikus-backup-export /usr/local/sbin/portikus-backup-export
	sed -e "s|@USER@|$$(id -un)|" -e "s|@BACKUP_DIR@|$(PORTIKUS_BACKUP_DIR)|" \
		-e "s|@RECIPIENTS@|$(abspath $(PORTIKUS_BACKUP_RECIPIENTS))|" -e "s|@VM_IP@|$(VM_IP)|" \
		infra/host/systemd/portikus-backup.service | sudo tee /etc/systemd/system/portikus-backup.service >/dev/null
	sudo install -m 0644 infra/host/systemd/portikus-backup.timer /etc/systemd/system/portikus-backup.timer
	sudo systemctl daemon-reload
	sudo systemctl enable --now portikus-backup.timer
	systemctl list-timers portikus-backup.timer --no-pager

# Replaces the target's database, so it refuses the pilot's environment, and
# restore.sh refuses any VM whose hostname is not the one in the state.
restore: ## Restore a backup set onto the rehearsal VM (TOFU_ENV=rehearsal-libvirt BACKUP=<set dir>; START_CHECK=1 starts one workspace and checks it; REMOVE=1 deletes the restored data afterwards)
	$(TOFU_BANNER)
	@test "$(TOFU_ENV)" != dev-libvirt || { echo "restore: refuses the pilot environment; pass TOFU_ENV=rehearsal-libvirt"; exit 1; }
	@test -n "$(BACKUP)" || { echo "restore: BACKUP=<set dir> is required, e.g. $(PORTIKUS_BACKUP_DIR)/<timestamp>"; exit 1; }
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
