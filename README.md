# opencode ↔ Telegram bridge

Mirrors a live opencode session to Telegram so you can follow and steer it from your phone.

The opencode **server is the hub**; the TUI and this bridge are both clients of it:

```
opencode serve --port 4096          ← holds the sessions
   ├── opencode attach :4096        ← your TUI, on your desk
   └── telegram-bridge              ← this script
```

Messages from Telegram are typed into the TUI's prompt box (`/tui/append-prompt` +
`/tui/submit-prompt`) rather than sent straight to the session. The TUI stays the
single writer, so what's on your screen and what's in the chat can't drift apart.

## Setup

On Ubuntu, `make deps install setup` covers steps 2–3 (installs bun + opencode via
their official scripts). `make check` verifies everything is ready; `make dev` runs it.

1. **Create a bot.** Message [@BotFather](https://t.me/botfather) → `/newbot` → copy the token.
   Use a *separate* bot from any other Claude/opencode integration — Telegram allows
   only one `getUpdates` consumer per token, and the loser gets `409 Conflict`.

2. **Configure.**
   ```bash
   cd telegram-bridge
   cp .env.example .env
   bun install
   ```
   Put the token in `.env`. Leave `TELEGRAM_ALLOWED_CHAT_IDS` set to `0` for now.

3. **Learn your chat ID.** Run `bun start`, send `/whoami` to the bot, put the ID it
   reports into `TELEGRAM_ALLOWED_CHAT_IDS`, restart.

4. **Run it**, with the server and TUI already up:
   ```bash
   opencode serve --port 4096              # terminal 1
   opencode attach http://127.0.0.1:4096   # terminal 2
   bun start                               # terminal 3
   ```

## Commands

| Command | Effect |
|---|---|
| any text | typed into the TUI prompt and submitted |
| `/status` | server health, URL, session count |
| `/sessions` | ten most recent sessions |
| `/rename <title>` | rename the most recent session |
| `/model <provider/model-id>` | switch the model of the most recent session |
| `/screenshot` | capture the terminal window running the TUI |
| `/stop` | abort the most recent session |
| `/whoami` | your chat ID |
| `/help` | list all commands |
| `!cmd` | run a shell command in the most recent session |

Permission requests appear as **Once / Always / Deny** buttons; questions appear as
option buttons. Without answering them the session just blocks, so this is the part
that makes remote driving actually work.

Plain-text prompts get an instant 👍, then a **semantic upgrade**: the bridge asks
the server's own model (in a throwaway session that is never mirrored to the chat)
to classify the request and replaces the reaction with 👀 question · 👌 easy ·
🤔 medium · 🔥 hard. Telegram reactions are a fixed whitelist, which is why the
choices are oblique. If classification fails or times out, the 👍 simply stays.

## How the streaming works

- `message.part.updated` carries the **cumulative** text of a part, not a fragment —
  which is exactly what `editMessageText` wants, so deltas are ignored entirely and
  no reassembly is needed.
- Edits are debounced to `EDIT_INTERVAL_MS` (default 1200ms). Telegram throttles to
  roughly one edit per second per chat.
- `session.idle` ends a turn: flush immediately, then the next turn opens a new message.
- Output past ~3800 chars spills into a fresh message, split on a newline where possible.
- `tui.*` events the bridge itself caused are dropped, or it would mirror itself in a loop.
- The event stream reconnects with exponential backoff; a drop is normal.

## Security

This bot can run anything on your machine. It fails closed:

- Empty `TELEGRAM_ALLOWED_CHAT_IDS` refuses to start.
- Every non-allowlisted chat is rejected and logged.
- Keep the server on `--hostname 127.0.0.1`.
- Set `OPENCODE_SERVER_PASSWORD` if anything else can reach the port.

`.env` is gitignored. Don't commit the token.

## Images

Two different pictures, two different paths:

- **The TUI itself** — `/screenshot`. Finds the terminal window by matching the
  `opencode attach` process's tty against Terminal's tabs, so it grabs the right
  window even when it isn't frontmost. Falls back to the whole display.
- **The app the agent is building** — the agent's `screenshot` skill
  (`~/.config/opencode/skills/screenshot`) captures a window via `cua-driver`
  and writes a PNG. The relay scans tool output for image paths, checks the file
  exists, and uploads it. Nothing has to be sent explicitly.

Both send as **documents**, not photos: Telegram re-encodes photos to JPEG and
caps the long side at 1280px, which destroys terminal text and UI detail.

Paths are sent once each — the event stream repeats cumulative part updates, and
without a dedupe you would get the same screenshot on every tick. The agent must
therefore use a fresh filename per capture, which the skill spells out.

Two guards keep the temp dir and your chat under control:

- **Only fresh images send.** A path older than `IMAGE_MAX_AGE_MS` (default 5
  min) is skipped. The dedupe set lives in memory and resets on restart, so
  without this, one `ls` of the temp dir would re-send every screenshot in it.
- **Startup sweep.** Each boot deletes temp screenshots older than
  `TEMP_IMAGE_TTL_MS` (default 1h) — both the bridge's own captures and the
  `opencode/` scratch dir. There is no session-end hook, so the previous
  session's leftovers are cleaned the next time the bridge starts.

Because any existing image path in tool output gets uploaded, an agent that
mentions an unrelated `.png` will send it. The chat is allowlisted and the agent
already has a shell, so this widens nothing that wasn't already open — but it is
worth knowing before you point this at a directory of private images.

## Known gaps

- Relays every session on the server, not just the TUI's focused one (`/session/active`
  returns a 500 on 1.18.10, so there's no reliable "current session" to filter on).
- Broadcasts to all allowlisted chats; there's no per-chat session routing yet.
- Message IDs are tracked for the first allowlisted chat only, so edits in a second
  chat will fail. Fine for a single user.
- No *inbound* file/photo handling — outbound images work, but you cannot send
  the agent a picture from your phone.
