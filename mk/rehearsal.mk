# The rebuild-from-code exercise (docs/archive/epics/EPIC-12B.md, B5; STACK.md section 33).
.PHONY: rebuild-exercise rehearsal-address

# The VM address must come from the rehearsal state, never from the caller:
# a VM_IP given on the command line or in the environment could be the pilot's.
REHEARSAL_OWN_ADDRESS = test "$(origin VM_IP)" = file || test "$(origin VM_IP)" = undefined \
	|| { echo "$@: VM_IP comes from the rehearsal VM's OpenTofu state; do not set it ($(origin VM_IP) gave $(VM_IP))" >&2; exit 1; }

rebuild-exercise: ## Rebuild the rehearsal VM from code, restore BACKUP=<set>, smoke test, roll back to PREVIOUS_VERSION=<release> or PREVIOUS_DEB=<file>, then destroy it (PORTIKUS_SMOKE_SIGNIN_FILE=<file>; the set must hold dex.dump)
	@test "$(origin TOFU_ENV)" != "command line" || test "$(TOFU_ENV)" = rehearsal-libvirt \
		|| { echo "rebuild-exercise: runs on the rehearsal VM only, not TOFU_ENV=$(TOFU_ENV)"; exit 1; }
	@$(REHEARSAL_OWN_ADDRESS)
	@test -n "$(BACKUP)" || { echo "rebuild-exercise: BACKUP=<set dir> is required, e.g. $(PORTIKUS_BACKUP_DIR)/<vm name>/<timestamp>"; exit 1; }
	@test -n "$(PREVIOUS_VERSION)$(PREVIOUS_DEB)" || { echo "rebuild-exercise: PREVIOUS_VERSION=<release> or PREVIOUS_DEB=<file> names the package to roll back to"; exit 1; }
	@test -n "$(PORTIKUS_SMOKE_SIGNIN_FILE)" || { echo "rebuild-exercise: PORTIKUS_SMOKE_SIGNIN_FILE=<file> is required for the Dex sign-ins"; exit 1; }
	PREVIOUS_VERSION=$(PREVIOUS_VERSION) PREVIOUS_DEB=$(PREVIOUS_DEB) \
		PORTIKUS_SMOKE_SIGNIN_FILE="$(abspath $(PORTIKUS_SMOKE_SIGNIN_FILE))" \
		PORTIKUS_BACKUP_IDENTITY="$(PORTIKUS_BACKUP_IDENTITY)" \
		PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
		bash infra/tests/rebuild-exercise.sh $(BACKUP)

# The rehearsal VM's address from its OpenTofu state, for the exercise script.
rehearsal-address:
	@test "$(TOFU_ENV)" = rehearsal-libvirt || { echo "rehearsal-address: TOFU_ENV must be rehearsal-libvirt" >&2; exit 1; }
	@$(REHEARSAL_OWN_ADDRESS)
	@echo $(VM_IP)
