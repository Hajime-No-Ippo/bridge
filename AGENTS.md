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
