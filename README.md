# local-is-agentic — Private offline auditor

> **No data leaves your machine. No score ends up on the internet forever.**

`is-agentic.com` publishes every report forever at `https://is-agentic.com/scan/<host>` (stable URL, shared cache, historical storage). CLI `npx is-agentic <domain>` also publishes if no report exists — it starts a scan on their server.

This tool replicates the same scoring model **locally** so you get the exact fixes without publishing.

**Source of truth:** https://is-agentic.com/methodology + https://is-agentic.com/docs + https://is-agentic.com/openapi.json

---

## Scoring (mirrors public methodology)

| Bucket | Points | When |
|--------|--------|------|
| **Essential** | 80 pts, 12 checks | Always scored |
| **Recommended** | 20 pts, conditional | Only if API / OAuth / GraphQL / MCP / commerce / docs detected — otherwise **excluded (not penalized)** |
| **Bonus** | +5 cap | Emerging: `llms.txt`, `openapi.json`, `/.well-known/api-catalog`, MCP card, sitemap |

`404` handling, server-rendered HTML, title/h1/meta/canonical/lang/viewport, robots, sitemap, landmarks, usable controls.

---

## Quick start

```bash
# no install, Node 18+ (native fetch), 0 deps
node auditor.mjs https://example.com
node auditor.mjs https://staging.yoursite.com --json | jq .
node auditor.mjs https://localhost:3000 --json

# make it a bin
npm link
local-is-agentic https://example.com
```

### Output modes

**Human (default):**
```
▲ / local-is-agentic  vercel.com
  █████████████████████████████░░░  91.7 / 100  Strong technical baseline
  1 failed · 2 partial
SCORE BREAKDOWN
  Essential     66.7 / 80
  Recommended   20.0 / 20
  Bonus            +5
FAILURES
  1. FAIL · ESSENTIAL  Agent-friendly 404s ...
```

**JSON (`--json`):** drop-in for `is-agentic --json`, same shape as `GET /api/v1/report?url=...`:

```json
{
  "target": "https://example.com",
  "score": 63.3,
  "score_label": "Needs work",
  "score_breakdown": { "essential": {...}, "recommended": {...}, "bonus": {...} },
  "issues": [{ "id": "essential-404s", "name": "...", "tier": "essential", "result": "failed", "details": "...", "recommendation": "..." }]
}
```

Use it in CI without publishing:
```bash
node auditor.mjs https://staging.example.com --json | jq -e '.score >= 75'
```

---

## Why not just use is-agentic.com?

| is-agentic.com | local-is-agentic |
|---|---|
| `GET /api/v1/report` never starts a scan, but `npx is-agentic` **does** start one if 404 — publishes result | **Never** calls is-agentic.com, Ora, or Vercel |
| Report is public forever at `/scan/<host>` | `local://audit/<host> (private — not published)` |
| 120 req / 60s / IP, bulk scanning prohibited | No limits — your machine, your target |
| Uses headless browser + Ora scoring | Static fetch only — conservative; if you pass here, you'll pass there |

---

## Privacy guarantee

Check yourself — the code never imports `is-agentic.com`:

```bash
grep -r "is-agentic.com" auditor.mjs || echo "no calls to is-agentic.com — clean"
grep -r "fetch" auditor.mjs | grep -v "$ORIGIN"
```

All `fetch()` targets are `ORIGIN + "/path"` — only your URL.

---

## What it checks (evidence + fix for each)

**Essential (12):**
1. `essential-http-200` — homepage returns 200
2. `essential-server-rendered` — `textLen > 1500` with H1 (no JS needed)
3. `essential-404s` — `GET /__is_agentic_nonexistent__<ts>` → 404/410, not 200 app shell
4. `essential-title` — 10–70 char title
5. `essential-h1` — single H1
6. `essential-meta-description` — 50–160 char
7. `essential-canonical` — `rel=canonical`
8. `essential-lang` — `<html lang>`
9. `essential-viewport` — `meta viewport`
10. `essential-robots` — `robots.txt` not `Disallow: /`
11. `essential-sitemap` — `sitemap.xml` or link
12. `essential-usable-controls` — no empty `<a>`, no `<div onclick>`

**Recommended (conditional):** api-docs, oauth discovery, graphql endpoint, MCP card, commerce JSON-LD, dev portal — scored only if keywords detected.

**Bonus (+5):** `llms.txt`, `openapi.json`, `api-catalog`, MCP card, sitemap

Each finding mirrors is-agentic's `Evidence / Fix` with a copy-pasteable fix.

---

## Verified against public reports

```bash
node auditor.mjs https://vercel.com
# → 91.7 / 100 (public is-agentic reports 90 / 100) — same 404 + meta + controls gaps, same 5 bonus signals
# Delta = we use static HTML only; is-agentic uses rendered DOM. Directionally correct, conservative.

node auditor.mjs https://example.com
# → 63.3 / 100 — thin content, no meta/canonical/sitemap
```

---

## Workflow: get to 90+ without publishing

1. **Audit locally on staging:** `node auditor.mjs https://staging.yoursite.com`
2. Fix failing Essential first (404s, SSR, title/h1/canonical) — they carry 80pts
3. Add bonus signals if you want +5: `llms.txt`, `openapi.json`, `/.well-known/api-catalog`, MCP card
4. Re-run locally until `≥85` (if no API) or `≥90` (with API)
5. Only then — if you *want* a public score — submit the production URL to is-agentic.com

Already published and regret it? Request correction at https://is-agentic.com/contact — no API delete exists.

---

## Files

- `auditor.mjs` — single file, 0 deps, Node 18+
- `package.json` — `bin: local-is-agentic`
- `README.md` — this file

## License

ISC — do whatever you want, just don't publish someone else's domain without consent.
# local-is-agentic
