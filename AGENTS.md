# Agent Notes

Replies in this project are relayed to a Telegram chat by the bridge
(src/relay.ts), which sends them with `parse_mode: 'HTML'`. Markdown does
not render on the phone — it arrives as literal characters. Two output rules:

## 1. Plain text replies

No Markdown syntax in chat replies: no `**bold**`, no `#` headers, no
`[links](...)`, no pipe tables. Plain hyphens and numbered lists are fine.
Fenced code blocks (```) are the ONE exception that works: the relay converts
them to Telegram `<pre>` blocks (see `toTelegramHtml` in src/render.ts).

## 2. Tables as monospace blocks

Never send `| --- |` Markdown tables. Format tabular data as space-aligned
fixed-width columns inside a fenced block, so it renders monospace on the
phone and columns line up:

```
Name      PID    Status
Safari    689    running
Chrome    412    running
```

- Align with spaces only, no tabs (tab width varies per client).
- Keep the table narrow: phones show ~35-40 monospace chars per line
  before wrapping. Fewer columns, abbreviate headers.
- Keep fenced output well under 3800 chars (`TG_LIMIT` in src/render.ts)
  or it gets split mid-block.

## 3. Temporary browser-ops wiring

The browser helpers are implemented but not mapped to Telegram commands yet.
Until bot routing is added, treat them as semantic tools via shell execution.

Available helpers:
- `src/tools/operate_chrome.ts`
- `src/tools/operate_gmail.ts`
- `src/tools/operate_new_trends_twitter.ts`
- `src/tools/operate_polling_jobs.ts`

When a user asks for browser actions (open/search/read/query), run them with
`!cmd` + `bun -e` and import the helper directly, then return a compact plain
text summary.

Examples:

```bash
!cmd bun -e "import { operateChrome } from './src/tools/operate_chrome'; console.log(JSON.stringify(await operateChrome({ search: 'latest AI agent news' }), null, 2));"
```

```bash
!cmd bun -e "import { operateGmail } from './src/tools/operate_gmail'; console.log(JSON.stringify(await operateGmail({ mode: 'inbox' }), null, 2));"
```

```bash
!cmd bun -e "import { operateNewTrendsTwitter } from './src/tools/operate_new_trends_twitter'; console.log(JSON.stringify(await operateNewTrendsTwitter({}), null, 2));"
```

```bash
!cmd bun -e "import { operatePollingJobs } from './src/tools/operate_polling_jobs'; console.log(JSON.stringify(await operatePollingJobs({ keywords: 'frontend engineer', location: 'Dublin' }), null, 2));"
```

Guardrails:
- Default to read-only actions (`get_text`, `query_dom`) unless the user
  explicitly asks for mutations.
- For sensitive targets (mail, forms, posting), confirm intent before any
  action that sends, submits, or publishes.
- Summarize outcomes; avoid dumping huge JSON unless asked.
