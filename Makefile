# telegram-bridge — dev shortcuts + Ubuntu bootstrap.
# Note: /screenshot stays macOS-only (screencapture + Terminal.app); all other
# targets are portable.

.DEFAULT_GOAL := help

.PHONY: help deps install setup check bridge kill restart dev start test typecheck install-service uninstall-service logs

PORT     := 4096
HEALTH   := http://127.0.0.1:$(PORT)/doc
SERVE_LOG := /tmp/opencode-serve.log

# The directory opencode serves. This is NOT cosmetic: a session only runs under
# a server whose directory matches the session's own. Start the server somewhere
# else and prompts are still accepted with HTTP 204 and then silently never
# execute — no error, no events, no reply.
#
# Defaults to $HOME so existing sessions keep working. Point it at a project to
# scope opencode there:  make bridge OPENCODE_DIR=~/code/my-project
OPENCODE_DIR ?= $(HOME)

# Defined once and reused: the port and flag spelling were duplicated across
# targets and drifted, which is how `--port:4096` (not a real flag — it prints
# usage and exits) got into a second target after being fixed in the first.
define start_opencode
	command -v opencode >/dev/null || { echo "opencode missing — run: make deps"; exit 1; }; \
	test -d "$(OPENCODE_DIR)" || { echo "OPENCODE_DIR=$(OPENCODE_DIR) does not exist"; exit 1; }; \
	echo ">> starting opencode server on $(PORT) in $(OPENCODE_DIR)"; \
	cd "$(OPENCODE_DIR)" && nohup opencode serve --port $(PORT) >$(SERVE_LOG) 2>&1 & \
	for _ in $$(seq 1 30); do curl -sf $(HEALTH) >/dev/null && break; sleep 1; done; \
	curl -sf $(HEALTH) >/dev/null || { echo ">> server never came up — see $(SERVE_LOG)"; exit 1; }; \
	echo ">> opencode server: up ($$(curl -sf $(HEALTH:/doc=/path) | sed -n 's/.*\"directory\":\"\([^\"]*\)\".*/\1/p'))"
endef

# SIGTERM, wait, then SIGKILL. `lsof -ti` prints just the pid, and -sTCP:LISTEN
# keeps it to the listener rather than every client connected to the port.
define stop_opencode
	PID=$$(lsof -ti :$(PORT) -sTCP:LISTEN 2>/dev/null); \
	if [ -z "$$PID" ]; then echo ">> nothing listening on $(PORT)"; else \
		echo ">> stopping opencode server on $(PORT) (pid $$PID)"; \
		kill $$PID 2>/dev/null || true; \
		for _ in $$(seq 1 10); do lsof -ti :$(PORT) -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done; \
		if lsof -ti :$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
			echo ">> still up after SIGTERM — sending SIGKILL"; \
			kill -9 $$PID 2>/dev/null || true; sleep 1; \
		fi; \
		echo ">> stopped"; \
	fi
endef

help: ## show this list
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

kill: ## stop the opencode server holding the port
	@$(stop_opencode)

restart: ## stop the opencode server and start a fresh one
	@$(stop_opencode)
	@$(start_opencode)

bridge: ## start the opencode server if it is down, then run the bridge
	@curl -sf $(HEALTH) >/dev/null && echo ">> opencode server: already up" || { $(start_opencode); }
	@echo ">> attach the TUI from another terminal:  opencode attach http://127.0.0.1:$(PORT)"
	@echo ">> bridge starting (ctrl-c to stop)..."
	bun run dev

deps: ## Ubuntu: install bun and opencode if missing
	@command -v bun >/dev/null || { \
		echo ">> installing bun"; \
		sudo apt-get update && sudo apt-get install -y curl unzip && \
		curl -fsSL https://bun.sh/install | bash; \
		echo ">> add ~/.bun/bin to PATH (relogin or: export PATH=\$$HOME/.bun/bin:\$$PATH)"; }
	@command -v opencode >/dev/null || { \
		echo ">> installing opencode"; \
		curl -fsSL https://opencode.ai/install | bash; }

install: ## install node dependencies
	bun install

setup: ## first time: create .env from the template
	@test -f .env || { cp .env.example .env; \
		echo ">> .env created — set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS"; }

check: ## verify prerequisites before running
	@command -v bun >/dev/null || { echo "bun missing — run: make deps"; exit 1; }
	@test -f .env || { echo ".env missing — run: make setup"; exit 1; }
	@curl -sf http://127.0.0.1:4096/doc >/dev/null \
		&& echo "opencode server: up" \
		|| { echo "opencode server: DOWN — start it: opencode serve --port 4096"; exit 1; }

dev: check ## run with auto-restart (watches src/)
	bun run dev

start: check ## run once
	bun run start

test: ## bun test
	bun run test

typecheck: ## tsc --noEmit
	bun run typecheck

# User units, not system ones: they run as you, so they inherit your ~/.config/
# opencode, your PATH and your .env without any of it being readable by other
# users. The cost is that user units do not start at boot until lingering is
# enabled, which is why enable-linger below is not optional.
SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user

# The project opencode serves. This decides its worktree and therefore which
# paths count as "external" and prompt for permission — so it should be the
# repo you actually work on, not this one:
#   make install-service OPENCODE_DIR=~/code/my-project
OPENCODE_DIR ?= $(HOME)

install-service: ## install+enable systemd user units (Linux only; set OPENCODE_DIR=)
	@command -v systemctl >/dev/null || { echo "systemd not found — this target is for Linux"; exit 1; }
	@command -v bun >/dev/null || { echo "bun missing — run: make deps"; exit 1; }
	@command -v opencode >/dev/null || { echo "opencode missing — run: make deps"; exit 1; }
	@test -f .env || { echo ".env missing — run: make setup"; exit 1; }
	@mkdir -p $(SYSTEMD_USER_DIR)
	@test -d "$(OPENCODE_DIR)" || { echo "OPENCODE_DIR=$(OPENCODE_DIR) does not exist"; exit 1; }
	@sed -e 's|__OPENCODE_WORKDIR__|$(abspath $(OPENCODE_DIR))|g' \
	     -e 's|__OPENCODE__|$(shell command -v opencode)|g' \
	     -e 's|__PORT__|4096|g' \
	     deploy/opencode-server.service > $(SYSTEMD_USER_DIR)/opencode-server.service
	@sed -e 's|__WORKDIR__|$(CURDIR)|g' \
	     -e 's|__BUN__|$(shell command -v bun)|g' \
	     deploy/telegram-bridge.service > $(SYSTEMD_USER_DIR)/telegram-bridge.service
	@systemctl --user daemon-reload
	@systemctl --user enable --now opencode-server.service telegram-bridge.service
	@loginctl enable-linger $(USER) 2>/dev/null || \
		echo ">> could not enable linger — run: sudo loginctl enable-linger $(USER)"
	@echo ">> installed. status:  systemctl --user status telegram-bridge"
	@echo ">> logs:               make logs"

uninstall-service: ## stop and remove the systemd user units
	-@systemctl --user disable --now telegram-bridge.service opencode-server.service 2>/dev/null
	-@rm -f $(SYSTEMD_USER_DIR)/telegram-bridge.service $(SYSTEMD_USER_DIR)/opencode-server.service
	-@systemctl --user daemon-reload
	@echo ">> removed"

logs: ## follow both services' logs
	journalctl --user -u telegram-bridge -u opencode-server -f --output=short-iso
