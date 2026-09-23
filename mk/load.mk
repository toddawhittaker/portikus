# The load and concurrency test (docs/EPIC-12B.md, B4; docs/CAPACITY.md).
.PHONY: load-test

N ?= 25

load-test: ## Load test N workspaces on the rehearsal VM (TOFU_ENV=rehearsal-libvirt; N=25; SWEEP=1 removes an earlier run's leftovers; LOAD_STEADY_SECONDS=900)
	@test "$(TOFU_ENV)" != dev-libvirt || { echo "load-test: never on the pilot; use TOFU_ENV=rehearsal-libvirt"; exit 1; }
	@test -n "$(VM_IP)" || { echo "load-test: no VM address; start the rehearsal VM first or pass VM_IP=<ip>"; exit 1; }
	PORTIKUS_PUBLIC_HOST=$(PORTIKUS_PUBLIC_HOST) PORTIKUS_PUBLIC_PORT=$(PORTIKUS_PUBLIC_PORT) \
		bash infra/tests/load-test.sh $(VM_IP) $(N) $(if $(SWEEP),--sweep,)
