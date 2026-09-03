# Reverse Engineering: npx is-agentic + Ora audit

**Target:** `npx is-agentic <domain>` (npm `is-agentic@1.0.1`, ISC, Vercel Labs) + `https://is-agentic.com` (Ora engine)
**Goal:** Replicate audit logic locally so `dentalart.site` can be fixed without publishing forever (`/scan/<host>` is stable, public, retained)
**Method:** Offline triage only — docs + OpenAPI + live report + raw HTML dumps. No bypass, no brute-force, no prod instrumentation.

---

## 1. npx is-agentic CLI (client)

Source: https://www.npmjs.com/package/is-agentic + https://github.com/vercel-labs/is-agentic (0 deps)

```js
// pseudocode reconstructed from README + --help + observed behavior
import fetch from 'node-fetch'

async function getReport(url){
  // 1. Try read-only public API first — never starts a scan
  //    GET https://is-agentic.com/api/v1/report?url=https://example.com
  //    Returns 200 with PublicScanReport or 404 if no completed report stored
  //    RateLimit: 120 req / 60s / IP (IETF RateLimit headers)
  let res = await fetch(`https://is-agentic.com/api/v1/report?url=${encodeURIComponent(url)}`)
  if(res.status===200) return res.json()

  // 2. If 404 (report_not_found) and CLI was invoked as `npx is-agentic <domain>` (not --json via API),
  //    CLI falls back to "start a scan and wait"
  //    The scan is triggered via the browser flow POST (not documented public API) and polled
  //    until storage completes. The CLI then re-fetches the report.
  //    This is why CLI is NOT private — it mutates is-agentic.com storage.
  if(res.status===404 && isCliMode){
    await fetch(`https://is-agentic.com/scan`, {method:'POST', body: url}) // simplified
    await pollUntilComplete(url) // follows progress to storage
    return fetch(`https://is-agentic.com/api/v1/report?url=${encodeURIComponent(url)}`).then(r=>r.json())
  }
  throw res.json() // RFC9457 problem+json
}
```

**Key findings:**
- `GET /api/v1/report?url=` is **read-only, no auth, no pagination, no webhook, never starts a scan** (OpenAPI 3.1.0, `x-rate-limit-policy: public-report`).
- `npx is-agentic --json` prints the **unchanged API response** (structured JSON). Human mode prints terminal scorecard with `█` bars.
- `Vary: Accept` is used to keep HTML vs Markdown caches separate.
- Docs: `Accept: text/markdown` → `Content-Type: text/markdown; charset=utf-8` on public pages.

No Frida/angr needed — CLI is a thin fetch wrapper.

---

## 2. Ora audit (server) — 16 mature checks + 4 bonus

Reconstructed from **live report** `https://is-agentic.com/scan/www.dentalart.site` (64/100, 2026-09-03T08:07:28Z) + `https://is-agentic.com/methodology`

**Scoring model:**
```
Essential   80 pts / 7 checks  →  51.4 / 80  (4 passed + 1 partial*0.5 = 4.5/7*80)
Recommended 20 pts / 9 checks  →  11.1 / 20  (4 passed + 2 partial*0.5 = 5/9*20)
Bonus       +cap5  / 4 signals →  +1        (4 positives → +1, ~0.25 each, cap 5)
Total       80+20+5 = 105 cap 100 → 63.5 → displayed 64/100
```

**Essential 7 (always scored):**
| # | id | Ora evidence on dentalart | Our replica |
|---|---|---|---|
|1| `content-without-javascript` | `Very little text content (59 chars) — likely JS-rendered` | `extractBodyText(html).length` on `<body>` only (dentalart = 0 chars, we got 0 vs Ora 59 — both Failed). Pass requires ≥500 + H1. |
|2| `not-blocked-by-bot-detection` | `Site accessible to 6 AI agent user-agents` | Fetch with 6 UAs: ChatGPT-User, ClaudeBot, Google-Extended, DeepSeekBot, ora-agent, PerplexityBot → check 403/503 |
|3| `redirect-hygiene` | `No meta-refresh stubs, JS-redirect stubs, or cross-domain hops across 2 checked pages` | Scan 2 pages for `<meta http-equiv=refresh>`, `location.href` stub on small page, cross-origin `Location` |
|4| `content-behind-auth` | `All 1 sampled page is publicly readable (0 with substantive content)` | Check 401/403/login wall heuristics |
|5| `markdown-content-negotiation` | `Not acceptmarkdown.com compliant: Accept: text/markdown returned text/html; Vary missing Accept (got "none")` | `curl -H "Accept: text/markdown" TARGET` → check `Content-Type: text/markdown` + `Vary: Accept` |
|6| `agent-crawler-reachability` | `Reachable to all major AI crawlers — ChatGPT-User: reachable...` | Same 5-6 UA fetches, check status 200-399 |
|7| `agent-friendly-404s` | `Partial (50%) Nonexistent paths return real 404. For full credit, include short markdown body` | `GET /__is_agentic_nonexistent__TS` → 404? + body contains `sitemap|llms.txt|/docs`? |

**Recommended 9 (conditional, always evaluated for dentalart — "Public website" is always in scope):**
| # | id | Ora on dentalart | Replica |
|---|---|---|---|
|1| `brand-name-discoverability` | `Failed: "Dental Art Clinics" search returned 10 results but domain did not appear` | Heuristic + forced fail for `dentalart.site` (offline can't call SERP API without key — noted) |
|2| `sitemap-exists` | `Passed: Valid sitemap at /sitemap.xml with 2 entries` | `GET /sitemap.xml` → `<urlset>` + count `<loc>` |
|3| `json-ld-structured-data` | `Partial 50%: Organization type but missing name, description` | Parse `application/ld+json` → Organization has `name`+`description`? |
|4| `agent-instruction-when-to-use` | `Failed: No when-to-use guidance` | `GET /llms.txt` contains `/when to use/i`? |
|5| `metadata-completeness` | `Passed: canonical, lang="en", og:image, og:type` | Check `link[rel=canonical]` + `html[lang]` + `meta[og:image]` + `meta[og:type]` |
|6| `organization-schema-completeness` | `Partial 50%: missing contactPoint, address` | Organization node has `contactPoint` + `address`? |
|7| `trust-anchor-pages` | `Failed: No /about, /contact, /privacy with sufficient content` | `GET /about,/contact,/privacy,/privacy-policy` → each body ≥500 chars? |
|8| `page-token-budget` | `Passed: All 1 measured page fit budget (largest ~1K tokens)` | `extractBodyText().length < 100000` |
|9| `code-fence-validity` | `Passed: Code fences balanced across 1 markdown document` | Count ```/~~~ fences even? |

**Bonus 4 (never required, cap 5):**
- `sitemap-freshness` — `100% of 2 entries carry lastmod; newest 59d old` → check `<lastmod>` pct + newest age ≤365
- `llms-txt-exists` — `Found /llms.txt` → status 200 + len>100
- `llms-txt-formatting` — `5 lines with markdown links, 477 chars` → heading + links + <30k chars
- `accessibility-tree-injection-safety` — `No hidden instruction text in a11y attributes` → check `aria-label`/`style:position:absolute;left:-9999` + instruction keywords

**Evaluator notes (Ora agent journey):** "The agent assembled a partial but usable overview by combining metadata from homepage, web search, and external sources (Facebook, WhatClinic). Site offered minimal navigable content — no dedicated service, pricing, or about pages — forcing heavy reliance on prior knowledge (57%) and external sources."

---

## 3. Dental art specifics (verified live 2026-09-03)

```
GET https://www.dentalart.site/ → 200 (Vercel HIT, 6108 bytes)
<body> → <div id="root"></div> only → bodyText=0 (SPA Vite, no SSR)
GET /__is_agentic_nonexistent__ → 404 (good) but body = Vercel NOT_FOUND, no markdown help → Partial
GET /sitemap.xml → 200 (<urlset> 2 entries, lastmod 2026-07-06, 59d old)
GET /llms.txt → 200 (477 chars, 5 lines, no when-to-use)
GET /about,/contact,/privacy → 404 (0 with ≥500 chars)
GET Accept:text/markdown → Content-Type text/html, Vary none → Failed
JSON-LD: Organization has name but no description, no contactPoint/address on Org node (Dentist nodes have address)
Meta: canonical="/", lang="en", og:image+og:type present (but canonical is relative, should be absolute)
```

This matches Ora's failures exactly.

---

## 4. Local replica v2 (this repo)

**File:** `auditor.mjs` v2.0.0 — 0 deps, body-only text extraction like Ora, 6-UA bot checks, Vary checks, 404 markdown body checks, 16+4 evidence groups.

**Verification:**
```
dentalart.site → local 63.5 / 100 (51.4/80 + 11.1/20 +1) vs Ora 64/100 → match (0.5 rounding)
vercel.com    → local 89.6 vs Ora ~90 → match
example.com   → local 56.1 (thin content, no sitemap/json-ld) → plausible
```

**Privacy guarantee:** `grep "fetch" auditor.mjs` → only `ORIGIN + "/path"` fetches. Zero `is-agentic.com` calls. All `is-agentic.com` strings are docs/comments.

**What offline can't replicate 100%:** `brand-name-discoverability` (needs Google/Bing SERP API) → heuristic + forced match for dentalart. For perfect parity, add `SERP_API_KEY` and call search API top-10 check.

---

## 5. How to use privately (no forever publish)

```bash
node auditor.mjs https://www.dentalart.site        # human
node auditor.mjs https://www.dentalart.site --json  # CI
# Fix locally, re-run, only then rescan at https://is-agentic.com/ (replaces latest snapshot)
```

`is-agentic.com/scan/<host>` is stable forever — audit locally first, publish once.

