# Documented operator entry point (STACK.md section 31).
# Every target is a thin wrapper over a tool that stays usable on its own.

.PHONY: help install check typecheck lint format test build test-e2e dev clean \
       infra-check bootstrap-host wait-vm infra-plan infra-apply configure-vm smoke-test destroy-pilot rebuild-pilot \
       deploy-app db-migrate build-workspace-image workspace-create workspace-destroy

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
	rm -rf dist */*/dist */*/.tsbuild coverage playwright-report test-results
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
	find . -name '*.sh' -not -path './node_modules/*' -not -path './.claude/*' -print0 | xargs -0 shellcheck

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

deploy-app: ## Rsync the app to the VM, install, build, migrate, and restart services
	@test -n "$(VM_IP)" || { echo "deploy-app: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	rsync -az --delete \
		--exclude=.git --exclude=node_modules --exclude=dist --exclude=.tsbuild \
		--exclude='infra/tofu/environments/*/terraform.tfstate*' \
		--exclude='infra/tofu/environments/*/.terraform*' \
		--exclude='.env*' --exclude='infra/secrets' --exclude='*.tfvars' \
		--exclude='*.tfstate*' --exclude='.claude' \
		./ deploy@$(VM_IP):/var/lib/portikus/app/
	ssh deploy@$(VM_IP) 'cd /var/lib/portikus/app && pnpm install --frozen-lockfile && pnpm build'
	$(MAKE) db-migrate VM_IP=$(VM_IP)
	ssh deploy@$(VM_IP) 'sudo systemctl restart portikus-controller portikus-worker portikus-api'

db-migrate: ## Run database migrations on the VM
	@test -n "$(VM_IP)" || { echo "db-migrate: no VM address; run make infra-apply first or pass VM_IP=<ip>"; exit 1; }
	ssh deploy@$(VM_IP) "sudo -u portikus DATABASE_URL='postgresql://portikus@/portikus?host=/var/run/postgresql' node /var/lib/portikus/app/packages/db/dist/migrate.js"

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
