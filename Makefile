# Documented operator entry point (STACK.md section 31).
# Every target is a thin wrapper over a tool that stays usable on its own.

.PHONY: help install check typecheck lint format test build test-e2e dev clean

help: ## Show the available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install workspace dependencies from the lockfile
	pnpm install --frozen-lockfile

check: typecheck lint test build ## Run every repository check

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
