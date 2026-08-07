# opencode ↔ Telegram bridge

Mirror a live opencode session to Telegram and steer it from your phone.

```
opencode serve --port 4096     ← holds the sessions
   └── telegram-bridge         ← this script (TUI optional)
```

Prompts go over the headless API (`prompt_async`); replies stream back on `/event`,
so no TUI is needed. `opencode attach :4096` is only for watching on your desk.

## Quick start

```bash
make deps install setup   # Ubuntu: bun + opencode + .env   (macOS: bun install, cp .env.example .env)
# put the bot token in .env; send /whoami to learn your chat ID, add it to TELEGRAM_ALLOWED_CHAT_IDS
make bridge               # starts the opencode server if it's down, then runs the bridge
```

Linux: `make install-service OPENCODE_DIR=~/code/my-project` runs both as systemd
user units; `make logs` tails them. (`OPENCODE_DIR` = the repo you work on, not this one.)

## Commands

| Send | Effect |
|---|---|
| text | submitted as a prompt |
| photo / file | attached to the prompt (caption is the instruction) |
| `/model <id>` · `/models` | switch / list models || `/rename <title>` | rename current session |
| `/stop` | abort current session |
| `!cmd` | run a shell command directly |
| `/status` · `/sessions` · `/whoami` · `/help` | status, list, your ID, help |

Permission requests → **Once / Always / Deny** buttons; questions → option buttons.
Answering them is what makes remote driving work.

Both block the turn until answered, so the bridge never lets one sit forever:

- Sending a new prompt **supersedes** any unanswered question — it is rejected and
  the turn is released, so typing the answer instead of tapping no longer wedges
  the session. Permissions are exempt: a typed message must never stand in for
  Approve/Deny.
- Anything still pending after `PENDING_TTL_MS` is rejected and its buttons
  retired, with a reminder every `PENDING_NUDGE_MS` until then.
- A block answered in the TUI is dropped on the next sweep (`GET /permission` and
  `GET /question` are the authority), and a turn that errors clears whatever it
  was blocked on. Both lists are also re-read at startup, so a restart cannot
  orphan a block the server is still waiting on.

## Notes

- Streaming: cumulative part text + debounced `editMessageText` (≈1/s), split past
  ~3800 chars. `session.idle` flushes the turn.
- Prompt with no activity after `SILENCE_WARN_MS` (20s) gets a 🔇 warning.
- Config: `TELEGRAM_ALLOWED_CHAT_IDS`, `OPENCODE_URL`, `OPENCODE_SERVER_PASSWORD`,
  `EDIT_INTERVAL_MS`, `MAX_INBOUND_BYTES`, `SILENCE_WARN_MS`, `PENDING_TTL_MS`,
  `PENDING_NUDGE_MS` (see `.env.example`).
- Vision/PDF: a model only accepts a photo or PDF if it advertises that input
  capability. The default `opencode` free tier and deepseek/moonshotai are
  text-only for PDFs. `make opencode-config` installs a provider config
  (deploy/opencode.example.json) that adds OpenAI (gpt-5.3-codex, gpt-4o) and
  Anthropic (claude-sonnet/opus) to the `/model` list — both read images and
  PDFs. It never overwrites an existing `~/.config/opencode/opencode.json`.

## Security

Fails closed: refuses to start with an empty allowlist, rejects unknown chats, keeps
the server on `127.0.0.1`, caps inbound files at 8MB. `.env` is gitignored.

## Known gaps

- Relays all sessions (no reliable "current session" filter), broadcasts to all
  allowlisted chats, edits track the first chat only.
- Browser operation helpers now exist under `src/tools/operate_*.ts`, but they are
  low-level wrappers (not yet wired to Telegram commands).
- Prompts submitted while a turn is blocked are recorded by opencode but never
  run, and releasing the block does not replay them. Re-send after answering.
