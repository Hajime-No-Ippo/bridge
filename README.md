# bridge

> Telegram-bridged OS automation agent: steer a live opencode session from your
> phone — browser control (macOS cua-driver / Linux CDP), pending-question
> lifecycle, attachment capability guard.

The theory behind Makescript: (Optional)

```
opencode serve --port 4096     ← holds the sessions
   └── telegram-bridge         ← this script (TUI optional)
```

Prompts go over the headless API (`prompt_async`); replies stream back on `/event`,
so no TUI is needed. `opencode attach :4096` is only for watching on your desk.

## Quick start

```make deps install setup``` concluded missing dependecies searching -> dependencies install -> verify if absent

```make bridge``` will automatically start opencode server and attach the session for you.

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
| `/new [title]` | start a fresh session; prompts go there, current model carried over |
| `/stop` | abort current session |
| `/screenshot` | capture the TUI window |
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
- Images: `/screenshot` captures the TUI; the relay also uploads fresh `.png` paths
  the agent's own `screenshot` skill produces. Sent as documents, deduped, mtime-capped.
- Config: `TELEGRAM_ALLOWED_CHAT_IDS`, `OPENCODE_URL`, `OPENCODE_SERVER_PASSWORD`,
  `EDIT_INTERVAL_MS`, `MAX_INBOUND_BYTES`, `MAX_IMAGE_BYTES`, `IMAGE_MAX_AGE_MS`,
  `TEMP_IMAGE_TTL_MS`, `SILENCE_WARN_MS`, `PENDING_TTL_MS`, `PENDING_NUDGE_MS`
  (see `.env.example`).
- Vision/PDF: a model only accepts a photo or PDF if it advertises that input
  capability, and the bridge now checks before submitting — an attachment is
  inlined into the session history permanently, so one incompatible file makes
  *every* later prompt in that session fail. A declared `input.<kind>: false`
  blocks; a declared `true` is only a hint, so `ATTACHMENT_DENY` can override a
  model that claims a modality and then rejects it. The default `opencode` free tier and deepseek/moonshotai are
  text-only for PDFs. `make opencode-config` installs a provider config
  (deploy/opencode.example.json) that adds OpenAI (gpt-5.3-codex, gpt-4o) and
  Anthropic (claude-sonnet/opus) to the `/model` list — both read images and
  PDFs. It never overwrites an existing `~/.config/opencode/opencode.json`.

- Polling slot: Telegram permits one `getUpdates` consumer per token, so an
  orphaned bridge wedges every later start with 409. On startup the bridge
  SIGTERMs the previous holder and takes over. The pidfile is keyed by a hash of
  the token, so two bots never evict each other, and the holder's command line is
  checked before signalling — a recycled pid belonging to something else is left
  alone (`BRIDGE_PID_FILE` overrides the location).

## Security

Fails closed: refuses to start with an empty allowlist, rejects unknown chats, keeps
the server on `127.0.0.1`, caps inbound files at 8MB.

## Known gaps

- Relays all sessions (no reliable "current session" filter), broadcasts to all
  allowlisted chats, edits track the first chat only.
- Browser operation helpers now exist under `src/tools/operate_*.ts`, but they are
  low-level wrappers (not yet wired to Telegram commands).
- Linux migration phase 1 (`src/ubuntu24/`) provides a CDP browser backend behind
  the same four-function seam, verified against real Chrome. The `operate_*.ts`
  tools still import the macOS cua-driver path directly — switching them over
  means adding `await`, since CDP is async where `execFileSync` was not.
- Prompts submitted while a turn is blocked are recorded by opencode but never
  run, and releasing the block does not replay them. Re-send after answering.

## Contributing

Found a bug or have an idea? Open an issue — reports and suggestions are welcome.
