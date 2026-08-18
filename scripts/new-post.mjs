#!/usr/bin/env node
/**
 * Create a new blog post from plain text.
 *
 * Usage:
 *   echo "Post content" | node scripts/new-post.mjs --title "My Post" --summary "One liner"
 *   node scripts/new-post.mjs --title "My Post" --content "Post content"
 *
 * Options:
 *   --title    (required) Post title
 *   --summary  (optional) One-line summary for the index page
 *   --content  (optional) Post body — if omitted, reads from stdin
 *   --date     (optional) Override date (YYYY-MM-DD), defaults to today
 *   --slug     (optional) Override auto-generated slug
 *   --dry-run  (optional) Print the output without writing or pushing
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, readSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const POSTS_DIR = resolve(__dirname, "..", "src", "posts")
const REPO_ROOT = resolve(__dirname, "..", "..", "..")

function parseArgs(argv) {
  const args = { dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "")
    if (key === "dry-run") {
      args.dryRun = true
    } else if (i + 1 < argv.length) {
      args[key] = argv[++i]
    }
  }
  return args
}

function toSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim()
}

/**
 * Auto-format plain text into markdown:
 * - Normalize line endings
 * - Detect bullet lines (-, *, •, or digit+period) and keep as list items
 * - Collapse multiple blank lines into exactly one
 * - Ensure a blank line before and after list blocks
 */
function formatMarkdown(text) {
  // Normalize line endings and strip trailing whitespace per line
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd())

  // Classify each line
  const classified = lines.map((line) => {
    const trimmed = line.trim()
    if (/^[-*•]\s+/.test(trimmed)) return { type: "bullet", text: trimmed.replace(/^[-*•]\s+/, "- ") }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const num = trimmed.match(/^(\d+)[.)]/)[1]
      return { type: "bullet", text: `${num}. ${trimmed.replace(/^\d+[.)]\s+/, "")}` }
    }
    if (trimmed === "") return { type: "blank" }
    return { type: "text", text: trimmed }
  })

  // Rebuild with proper paragraph and list spacing
  const out = []
  let inList = false

  for (let i = 0; i < classified.length; i++) {
    const { type, text } = classified[i]

    if (type === "blank") {
      // End a list block if we were in one
      if (inList) {
        out.push("")
        inList = false
      }
      // Collapse consecutive blanks: only emit one blank line max,
      // and only if the next non-blank line is text (not a list item,
      // which already has its own spacing).
      const next = classified.slice(i + 1).find((c) => c.type !== "blank")
      if (next && next.type === "text" && out.length > 0 && out[out.length - 1] !== "") {
        out.push("")
      }
      continue
    }

    if (type === "bullet") {
      if (!inList) {
        // Blank line before list starts
        if (out.length > 0 && out[out.length - 1] !== "") out.push("")
        inList = true
      }
      out.push(text)
      continue
    }

    // type === "text"
    inList = false
    out.push(text)
  }

  return out.join("\n").trim() + "\n"
}

// --- parse ---
const args = parseArgs(process.argv)

if (!args.title) {
  console.error("Error: --title is required.")
  process.exit(1)
}

const slug = args.slug || toSlug(args.title)
const date = args.date || todayISO()
const summary = args.summary || ""

let content = args.content || ""
if (!content) {
  // Read from stdin
  const chunks = []
  const fd = process.stdin.fd
  const buf = Buffer.alloc(1024)
  let n
  while ((n = readSync(fd, buf)) > 0) {
    chunks.push(buf.slice(0, n))
  }
  content = Buffer.concat(chunks).toString("utf8")
}

if (!content.trim()) {
  console.error("Error: no post content provided. Use --content or pipe to stdin.")
  process.exit(1)
}

// --- build file ---
const frontmatter = [
  "---",
  `title: ${args.title}`,
  `date: '${date}'`,
  summary ? `summary: ${summary}` : null,
  "---",
]
  .filter(Boolean)
  .join("\n")

const file = `${frontmatter}\n\n${formatMarkdown(content.trim())}`

// --- write ---
const outPath = join(POSTS_DIR, `${slug}.md`)

if (args.dryRun) {
  console.log(`[dry-run] Would write: ${outPath}`)
  console.log("---")
  console.log(file)
  process.exit(0)
}

mkdirSync(POSTS_DIR, { recursive: true })
writeFileSync(outPath, file, "utf8")
console.log(`wrote ${outPath}`)

// --- git ---
try {
  git(["add", outPath])
  git(["commit", "-m", `blog: add "${args.title}"`])
  git(["push", "origin"])
  console.log("pushed to origin")
} catch (err) {
  console.error(`git error: ${err.message}`)
  process.exit(1)
}


