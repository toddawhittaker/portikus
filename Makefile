# Documented operator entry point (STACK.md section 31).
# Every target is a thin wrapper over a tool that stays usable on its own.

.PHONY: help install check typecheck lint format test build test-e2e dev clean \
       infra-check bootstrap-host wait-vm infra-plan infra-apply configure-vm smoke-test destroy-pilot rebuild-pilot \
       build-deb deploy-app build-workspace-image workspace-create workspace-destroy

help: ## Show the available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install workspace dependencies from the lockfile
	pnpm install --frozen-lockfile

check: typecheck lint test build infra-check ## Run every repository check, including the infrastructure checks CI runs

typecheck: ## Type-check every package and app
	pnpm typecheck

lint: ## Lint and check formatting with Biome
	pnpm lint

format: ## Rewrite files to the Biome format
	pnpm format

test: ## Run the Vitest unit and integration tests
	pnpm test

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

TOFU_DIR := infra/tofu/environments/dev-libvirt

# Mirrors the "Infrastructure checks" job in .github/workflows/ci.yml.
infra-check: ## Run the infrastructure checks CI runs: tofu fmt/validate, ansible-lint, shellcheck
	@for t in tofu ansible-lint ansible-galaxy shellcheck; do \
		command -v $$t >/dev/null || { echo "infra-check: $$t is not installed (see docs/WORKFLOW.md, Local development)"; exit 1; }; \
	done
	tofu fmt -check -recursive infra/tofu
	cd $(TOFU_DIR) && tofu init -backend=false -input=false >/dev/null && tofu validate
	ansible-galaxy collection install --force -r infra/ansible/requirements.yml
	ansible-lint infra/ansible
	find . -name '*.sh' -not -path './node_modules/*' -not -path './dist/*' -not -path './.claude/*' -print0 | xargs -0 shellcheck

bootstrap-host: ## Install host prerequisites (KVM, libvirt, OpenTofu, Ansible, age, SOPS)
	bash infra/host/dev-libvirt/bootstrap.sh

infra-plan: ## Show what OpenTofu would change in the platform VM
	cd $(TOFU_DIR) && tofu init -input=false && tofu plan

infra-apply: ## Create or update the platform VM and disks
	cd $(TOFU_DIR) && tofu init -input=false && tofu apply

# The VM address comes from OpenTofu state; override with VM_IP=<ip>.
VM_IP ?= $(shell cd $(TOFU_DIR) 2>/dev/null && tofu output -json vm_ip 2>/dev/null | python3 -c 'import json,sys; print((json.load(sys.stdin) or [""])[0])')
MANAGEMENT_CIDR ?= $(shell cd $(TOFU_DIR) 2>/dev/null && tofu output -raw management_cidr 2>/dev/null)

# Block until the VM answers SSH and cloud-init has finished, so Ansible does
# not race the first-boot apt update. The known-hosts options are for the wait
# only: a rebuilt VM has a new host key at the same address.
wait-vm: ## Wait for the platform VM to finish first boot
	@test -n "$(VM_IP)" || { echo "wait-vm: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	@for i in $$(seq 1 60); do \
		ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
			-o LogLevel=ERROR deploy@$(VM_IP) 'cloud-init status --wait >/dev/null 2>&1; cloud-init status' 2>/dev/null && exit 0; \
		sleep 5; \
	done; echo "wait-vm: $(VM_IP) did not become ready"; exit 1

configure-vm: wait-vm ## Run Ansible to converge the platform VM
	cd infra/ansible && PORTIKUS_VM_IP=$(VM_IP) PORTIKUS_MANAGEMENT_CIDR=$(MANAGEMENT_CIDR) ansible-playbook site.yml

smoke-test: ## Run infrastructure smoke tests against the VM
	@test -n "$(VM_IP)" || { echo "smoke-test: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	bash infra/tests/smoke-test.sh $(VM_IP)

destroy-pilot: ## Destroy the platform VM (irreversible)
	cd $(TOFU_DIR) && tofu destroy

rebuild-pilot: destroy-pilot infra-apply configure-vm ## Destroy and recreate the platform VM

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
	ssh deploy@$(VM_IP) "sudo apt-get install -y --reinstall --allow-downgrades ./$$deb; rm -f ./$$deb"

# ── Workspace image and lifecycle targets ─────────────────────────

build-workspace-image: ## Build the workspace image on the VM with distrobuilder
	@test -n "$(VM_IP)" || { echo "build-workspace-image: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	rsync -av --delete infra/workspace-image/ deploy@$(VM_IP):/var/lib/portikus/image-build/
	rsync -av --delete infra/incus/ deploy@$(VM_IP):/var/lib/portikus/incus/
	ssh deploy@$(VM_IP) bash /var/lib/portikus/image-build/build-on-vm.sh

workspace-create: ## Create a test workspace (NAME=<name>)
	@test -n "$(NAME)" || { echo "workspace-create: NAME is required, e.g. make workspace-create NAME=alice"; exit 1; }
	@test -n "$(VM_IP)" || { echo "workspace-create: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	ssh deploy@$(VM_IP) bash /var/lib/portikus/incus/workspace.sh create $(NAME)

workspace-destroy: ## Destroy a test workspace (NAME=<name>)
	@test -n "$(NAME)" || { echo "workspace-destroy: NAME is required, e.g. make workspace-destroy NAME=alice"; exit 1; }
	@test -n "$(VM_IP)" || { echo "workspace-destroy: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	ssh deploy@$(VM_IP) bash /var/lib/portikus/incus/workspace.sh destroy $(NAME)
