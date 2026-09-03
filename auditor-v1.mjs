#!/usr/bin/env node
/**
 * local-is-agentic — Private offline replica of is-agentic.com scoring
 * 
 * Why this exists: is-agentic.com publishes every report at /scan/<host> forever
 * (stable public URL, shared cache, historical storage). If you don't want your
 * score on the internet forever, run this instead. Zero network calls to is-agentic.com.
 * 
 * Scoring model (from https://is-agentic.com/methodology):
 *   Essential    = 80 pt pool  (12 checks) — always scored
 *   Recommended  = 20 pt pool  (conditional — only if surface detected, otherwise excluded)
 *   Bonus        = +5 cap      (emerging formats like llms.txt, openapi.json, api-catalog, mcp)
 *   Not-applicable = excluded, not penalized
 * 
 * Usage:
 *   node auditor.mjs https://example.com
 *   node auditor.mjs https://localhost:3000 --json
 *   node auditor.mjs https://staging.yoursite.com --json | jq .
 * 
 * Node 18+ required (native fetch). Zero dependencies.
 */

const VERSION = "1.0.0";
const TIMEOUT_MS = 12000;
const UA = `local-is-agentic/${VERSION} (private audit; no data sent to is-agentic.com)`;

// ---------- CLI ----------
const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
local-is-agentic v${VERSION} — private Is Agentic auditor
No data is sent to is-agentic.com. All fetches go only to YOUR target URL.

Usage:
  node auditor.mjs <url> [--json] [--help]

Examples:
  node auditor.mjs https://example.com
  node auditor.mjs https://localhost:3000 --json
  node auditor.mjs https://staging.example.com --json | jq '.score'

What it checks (offline, 1 fetch per surface):
  Essential (80pts, 12 checks): HTTP 200, server-rendered HTML, 404 handling,
    title/h1/meta/canonical/lang/viewport, robots, sitemap, doc structure, controls
  Recommended (20pts, conditional): API/OAuth/GraphQL/MCP/commerce/developer-portal
    — only scored if surface is detected, otherwise excluded (not penalized)
  Bonus (+5 cap): llms.txt, openapi.json, api-catalog, mcp card, sitemap

Output --json matches is-agentic public API shape for drop-in scripts.

Privacy: This tool NEVER calls is-agentic.com, vercel, or ora.
`);
  process.exit(0);
}

const targetRaw = args.find(a => !a.startsWith("-"));
const wantJson = args.includes("--json") || args.includes("-j");

if (!targetRaw) {
  console.error("Error: missing <url>\nTry: node auditor.mjs https://example.com --help");
  process.exit(1);
}

// ---------- helpers ----------
function normalizeUrl(input) {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("only http/https");
    return parsed.toString().replace(/\/$/, "") || parsed.origin;
  } catch (e) {
    console.error(`Invalid URL: ${input} — ${e.message}`);
    process.exit(1);
  }
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*", ...opts.headers },
      signal: ctrl.signal,
      ...opts,
    });
    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, headers: res.headers, body, url: res.url, redirected: res.redirected };
  } catch (e) {
    return { ok: false, status: 0, headers: new Map(), body: "", error: e.message, url };
  } finally {
    clearTimeout(t);
  }
}

function parseHtmlMeta(html) {
  const lower = html.toLowerCase();
  const get = (re) => {
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };
  const has = (re) => re.test(html) || re.test(lower);

  // naive but zero-dep and good enough for audit signal
  const title = get(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
  const metaDesc = get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
                   get(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  const canonical = get(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*>/i) ||
                    get(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["'][^>]*>/i);
  const lang = get(/<html[^>]*lang=["']([^"']*)["'][^>]*>/i);
  const viewport = has(/<meta[^>]*name=["']viewport["'][^>]*>/i);
  const hasMain = has(/<main[^>]*>/i);
  const hasNav = has(/<nav[^>]*>/i);
  const hasFooter = has(/<footer[^>]*>/i);
  const textLen = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;

  // usable controls heuristics
  const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)].length;
  const links = [...html.matchAll(/<a[^>]*href[^>]*>([\s\S]*?)<\/a>/gi)];
  const emptyLinks = links.filter(m => m[1].replace(/<[^>]+>/g,"").trim().length === 0 && !/aria-label=/i.test(m[0])).length;
  const divOnClick = [...html.matchAll(/<div[^>]*onclick[^>]*>/gi)].length;
  const linksWithHref = links.length;

  return { title, h1s, metaDesc, canonical, lang, viewport, hasMain, hasNav, hasFooter, textLen, buttons, linksWithHref, emptyLinks, divOnClick };
}

function scoreLabel(score) {
  if (score >= 90) return "Strong technical baseline";
  if (score >= 75) return "Ready with gaps";
  if (score >= 55) return "Needs work";
  if (score >= 30) return "Weak agent surface";
  return "Not ready";
}

function bar(score, w=32) {
  const filled = Math.round((score/100)*w);
  return "█".repeat(filled) + "░".repeat(w-filled);
}

// ---------- main audit ----------
const TARGET = normalizeUrl(targetRaw);
const ORIGIN = new URL(TARGET).origin;

if (!wantJson) {
  console.log(`\n▲ / local-is-agentic  ${TARGET}`);
  console.log(`  private audit — no calls to is-agentic.com (UA: local-is-agentic/${VERSION})`);
  console.log(`  fetching ${TARGET} ...\n`);
}

const started = Date.now();
const home = await fetchWithTimeout(TARGET);
const html = home.body || "";
const meta = parseHtmlMeta(html);

// --- Essential checks (always scored, 80pts) ---
const essential = [];

// E01 HTTP 200
{
  const pass = home.status >= 200 && home.status < 300;
  const partial = home.status >= 300 && home.status < 400 && home.redirected;
  essential.push({
    id: "essential-http-200",
    name: "HTTP 200 for homepage",
    tier: "essential",
    result: pass ? "passed" : partial ? "partial" : "failed",
    details: pass ? `Homepage returns HTTP ${home.status} at ${home.url}` : `Homepage returned HTTP ${home.status} (expected 200). URL: ${home.url}${home.error?` — ${home.error}`:""}`,
    recommendation: pass ? null : "Ensure the public homepage returns HTTP 200 without requiring JS. Check redirects, auth walls, and bot challenges.",
    evidence: `GET ${TARGET} → ${home.status}`,
  });
}

// E02 Server-rendered content
{
  const pass = meta.textLen > 1500 && meta.h1s.length > 0;
  const partial = meta.textLen > 700;
  essential.push({
    id: "essential-server-rendered",
    name: "Server-rendered content",
    tier: "essential",
    result: pass ? "passed" : partial ? "partial" : "failed",
    details: pass ? `Initial HTML contains ${meta.textLen} chars and H1 "${meta.h1s[0]?.slice(0,80)}"` : `Initial HTML is thin (${meta.textLen} chars, ${meta.h1s.length} H1s). Agents without JS will see almost nothing.`,
    recommendation: pass ? null : "Render primary content in the initial HTML response (SSR/SSG). Avoid app-shell that requires JS to show H1 and body.",
    evidence: `textLen=${meta.textLen}, h1s=${meta.h1s.length}`,
  });
}

// E03 404 behavior — request a guaranteed nonexistent path
let notFound = { status: 0, body: "" };
{
  const probe = ORIGIN + "/__is_agentic_nonexistent__" + Date.now();
  notFound = await fetchWithTimeout(probe);
  const pass = notFound.status === 404 || notFound.status === 410;
  const isAppShell = notFound.status === 200 && notFound.body.length > 500 && /<html/i.test(notFound.body);
  essential.push({
    id: "essential-404s",
    name: "Agent-friendly 404s",
    tier: "essential",
    result: pass ? "passed" : isAppShell ? "failed" : notFound.status === 200 ? "failed" : "partial",
    details: pass ? `Nonexistent path correctly returns ${notFound.status}` : isAppShell ? `Nonexistent path returns HTTP 200 with app shell (soft 404). Agents can't tell what's real.` : `Nonexistent path returns HTTP ${notFound.status} (expected 404/410).`,
    recommendation: pass ? null : "Return a real HTTP 404 or 410 for nonexistent paths. Don't serve 200 + app shell.",
    evidence: `GET ${probe} → ${notFound.status}`,
  });
}

// E04 Title
{
  const pass = meta.title && meta.title.length >= 10 && meta.title.length <= 70;
  const partial = !!meta.title;
  essential.push({
    id: "essential-title",
    name: "Document title",
    tier: "essential",
    result: pass ? "passed" : partial ? "partial" : "failed",
    details: pass ? `Title: "${meta.title}" (${meta.title.length} chars)` : meta.title ? `Title is present but weak: "${meta.title}" (${meta.title.length} chars, aim 10-70)` : "No <title> found in initial HTML.",
    recommendation: pass ? null : "Add a concise <title> (10–70 chars) that describes the page. One per document.",
    evidence: `title="${meta.title || ""}"`,
  });
}

// E05 H1
{
  const pass = meta.h1s.length === 1 && meta.h1s[0].length > 3;
  const partial = meta.h1s.length >= 1;
  essential.push({
    id: "essential-h1",
    name: "Clear heading hierarchy",
    tier: "essential",
    result: pass ? "passed" : partial ? "partial" : "failed",
    details: pass ? `Single H1: "${meta.h1s[0]}"` : meta.h1s.length === 0 ? "No <h1> found." : `Found ${meta.h1s.length} H1s: ${meta.h1s.slice(0,2).map(s=>`"${s.slice(0,40)}"`).join(", ")} — aim for one clear H1.`,
    recommendation: pass ? null : "Use one descriptive <h1> per page, then h2/h3 for sections. Agents use headings to understand structure.",
    evidence: `h1s=${JSON.stringify(meta.h1s.slice(0,3))}`,
  });
}

// E06 Meta description
{
  const pass = meta.metaDesc && meta.metaDesc.length >= 50 && meta.metaDesc.length <= 160;
  const partial = !!meta.metaDesc;
  essential.push({
    id: "essential-meta-description",
    name: "Meta description",
    tier: "essential",
    result: pass ? "passed" : partial ? "partial" : "failed",
    details: pass ? `Meta description: "${meta.metaDesc.slice(0,120)}"` : partial ? `Meta description present but thin: "${meta.metaDesc}"` : "No meta description found.",
    recommendation: pass ? null : "Add <meta name=\"description\" content=\"...\"> (50–160 chars) summarizing the page.",
    evidence: `metaDesc="${meta.metaDesc || ""}"`,
  });
}

// E07 Canonical
{
  const pass = !!meta.canonical;
  essential.push({
    id: "essential-canonical",
    name: "Canonical URL",
    tier: "essential",
    result: pass ? "passed" : "failed",
    details: pass ? `Canonical: ${meta.canonical}` : "No <link rel=\"canonical\"> found.",
    recommendation: pass ? null : "Add <link rel=\"canonical\" href=\"https://...\"> to the canonical version of the page.",
    evidence: `canonical="${meta.canonical || ""}"`,
  });
}

// E08 Lang
{
  const pass = !!meta.lang && meta.lang.length >= 2;
  essential.push({
    id: "essential-lang",
    name: "HTML lang attribute",
    tier: "essential",
    result: pass ? "passed" : "failed",
    details: pass ? `<html lang="${meta.lang}"> present` : "No <html lang> attribute. Agents and assistive tech can't infer language.",
    recommendation: pass ? null : "Add <html lang=\"en\"> (or your locale) to the root element.",
    evidence: `lang="${meta.lang || ""}"`,
  });
}

// E09 Viewport
{
  const pass = meta.viewport;
  essential.push({
    id: "essential-viewport",
    name: "Viewport for mobile agents",
    tier: "essential",
    result: pass ? "passed" : "failed",
    details: pass ? "Meta viewport present." : "No <meta name=\"viewport\">. Mobile rendering and some agent crawlers will degrade.",
    recommendation: pass ? null : "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.",
    evidence: `viewport=${pass}`,
  });
}

// E10 Robots
let robots = { status: 0, body: "" };
{
  robots = await fetchWithTimeout(ORIGIN + "/robots.txt");
  const isBlocking = /Disallow:\s*\/\s*$/m.test(robots.body) && !/Allow:/i.test(robots.body);
  const pass = robots.status === 200 && !isBlocking;
  const partial = robots.status === 404; // no robots.txt is okay, not blocking
  essential.push({
    id: "essential-robots",
    name: "Crawler policy (robots.txt)",
    tier: "essential",
    result: pass || partial ? "passed" : "failed",
    details: robots.status === 200 ? (isBlocking ? "robots.txt blocks all crawling (Disallow: /)." : `robots.txt fetchable (${robots.body.split("\n").length} lines).`) : robots.status === 404 ? "No robots.txt (defaults to allow — okay)." : `robots.txt returned ${robots.status}.`,
    recommendation: (pass || partial) ? null : "Fix robots.txt — don't Disallow: / on a public site you want agents to read.",
    evidence: `GET ${ORIGIN}/robots.txt → ${robots.status}`,
  });
}

// E11 Sitemap
let sitemap = { status: 0, body: "" };
{
  sitemap = await fetchWithTimeout(ORIGIN + "/sitemap.xml");
  const hasSitemapLink = /sitemap/i.test(html);
  const pass = sitemap.status === 200 && /<urlset|<sitemapindex/i.test(sitemap.body);
  const partial = sitemap.status === 200 || hasSitemapLink;
  essential.push({
    id: "essential-sitemap",
    name: "Sitemap discovery",
    tier: "essential",
    result: pass ? "passed" : partial ? "partial" : "failed",
    details: pass ? "Valid sitemap.xml found." : partial ? `Sitemap hint found but weak (status ${sitemap.status}, html mentions sitemap: ${hasSitemapLink}).` : "No sitemap.xml found and no sitemap link in HTML.",
    recommendation: pass ? null : "Publish /sitemap.xml and link it in robots.txt or footer. Helps agents discover pages.",
    evidence: `GET ${ORIGIN}/sitemap.xml → ${sitemap.status}`,
  });
}

// E12 Usable controls
{
  const pass = meta.emptyLinks === 0 && meta.divOnClick === 0;
  const partial = meta.emptyLinks <= 2 && meta.divOnClick <= 1;
  const issues = [];
  if (meta.emptyLinks > 0) issues.push(`${meta.emptyLinks} empty <a> without text/aria-label`);
  if (meta.divOnClick > 0) issues.push(`${meta.divOnClick} <div onclick> without button role`);
  essential.push({
    id: "essential-usable-controls",
    name: "Usable controls",
    tier: "essential",
    result: pass ? "passed" : partial ? "partial" : "failed",
    details: pass ? `Links/buttons look usable (${meta.linksWithHref} links, ${meta.buttons} buttons).` : `Potential control issues: ${issues.join("; ")} — agents need semantic controls.`,
    recommendation: pass ? null : "Use <button> and <a href> with visible text or aria-label. Avoid <div onclick> — use <button> instead. Ensure every link has a name.",
    evidence: `links=${meta.linksWithHref}, emptyLinks=${meta.emptyLinks}, divOnClick=${meta.divOnClick}, buttons=${meta.buttons}`,
  });
}

// --- Recommended checks (conditional, 20pts, excluded if not applicable) ---
const recommended = [];
const htmlLowerForDetect = html.toLowerCase();

// helper to detect surface
function detectSurface(keywords) {
  return keywords.some(k => htmlLowerForDetect.includes(k) || meta.title?.toLowerCase().includes(k));
}

const surfaces = {
  api: detectSurface(["/api", "openapi", "swagger", "rest api", "api docs", "api reference"]),
  oauth: detectSurface(["oauth", "oauth2", "oidc", "authorization_code"]),
  graphql: detectSurface(["graphql", "/graphql"]),
  mcp: detectSurface(["mcp server", "model context protocol", "mcp://", ".well-known/mcp"]),
  commerce: detectSurface(["/cart", "/checkout", "add to cart", "shopify", "commerce"]),
  devportal: detectSurface(["developer", "/docs", "documentation", "api reference"]),
};

// fetch probes for recommended (only if surface detected to avoid noise)
let openapiProbe = { status: 0 }, docsProbe = { status: 0 }, graphqlProbe = { status: 0 };
if (surfaces.api || surfaces.devportal) {
  [openapiProbe, docsProbe] = await Promise.all([
    fetchWithTimeout(ORIGIN + "/openapi.json"),
    fetchWithTimeout(ORIGIN + "/docs"),
  ]);
}
if (surfaces.graphql) {
  graphqlProbe = await fetchWithTimeout(ORIGIN + "/graphql");
}

// R01 API docs
{
  const applicable = surfaces.api;
  if (!applicable) {
    recommended.push({ id:"recommended-api-docs", name:"API documentation", tier:"recommended", result:"not_applicable", details:"No API surface detected in HTML — excluded (not penalized).", recommendation:null, evidence:"no /api/openapi/swagger signals in HTML" });
  } else {
    const pass = openapiProbe.status === 200 || docsProbe.status === 200;
    const partial = /api/i.test(html) && !pass;
    recommended.push({
      id:"recommended-api-docs", name:"API documentation", tier:"recommended",
      result: pass ? "passed" : partial ? "partial" : "failed",
      details: pass ? `API surface documented (openapi.json: ${openapiProbe.status}, /docs: ${docsProbe.status})` : `API keywords found but no discoverable docs (openapi.json: ${openapiProbe.status}, /docs: ${docsProbe.status}).`,
      recommendation: pass ? null : "Publish OpenAPI at /openapi.json and link it from /docs and /.well-known/api-catalog. See is-agentic docs for RFC 9727.",
      evidence: `GET /openapi.json → ${openapiProbe.status}, GET /docs → ${docsProbe.status}`,
    });
  }
}

// R02 OAuth
{
  const applicable = surfaces.oauth;
  if (!applicable) recommended.push({ id:"recommended-oauth", name:"OAuth discovery", tier:"recommended", result:"not_applicable", details:"No OAuth surface detected — excluded.", recommendation:null, evidence:"no oauth keywords" });
  else {
    const hasDiscovery = /well-known.*oauth|\.well-known\/openid/i.test(html);
    const discoveryProbe = hasDiscovery ? { status: 200 } : await fetchWithTimeout(ORIGIN + "/.well-known/openid-configuration");
    const pass = hasDiscovery || discoveryProbe.status === 200;
    recommended.push({
      id:"recommended-oauth", name:"OAuth discovery", tier:"recommended",
      result: pass ? "passed" : "partial",
      details: pass ? "OAuth discovery endpoint hint found." : "OAuth mentioned but no discovery doc at /.well-known/openid-configuration.",
      recommendation: pass ? null : "Expose OAuth/OIDC discovery at /.well-known/openid-configuration or /.well-known/oauth-authorization-server.",
      evidence: `probe ${ORIGIN}/.well-known/openid-configuration → ${discoveryProbe.status}`,
    });
  }
}

// R03 GraphQL
{
  const applicable = surfaces.graphql;
  if (!applicable) recommended.push({ id:"recommended-graphql", name:"GraphQL introspection", tier:"recommended", result:"not_applicable", details:"No GraphQL surface detected — excluded.", recommendation:null, evidence:"no graphql keywords" });
  else {
    const pass = graphqlProbe.status === 200 || graphqlProbe.status === 400; // 400 often means endpoint exists but needs query
    recommended.push({
      id:"recommended-graphql", name:"GraphQL endpoint", tier:"recommended",
      result: pass ? "passed" : "failed",
      details: pass ? `GraphQL endpoint responds (${graphqlProbe.status}).` : `GraphQL keyword found but endpoint /graphql → ${graphqlProbe.status}.`,
      recommendation: pass ? null : "Ensure /graphql is reachable and documents its schema. Consider disabling introspection in prod but keeping docs.",
      evidence: `GET /graphql → ${graphqlProbe.status}`,
    });
  }
}

// R04 MCP
{
  const applicable = surfaces.mcp;
  if (!applicable) recommended.push({ id:"recommended-mcp", name:"MCP server discovery", tier:"recommended", result:"not_applicable", details:"No MCP surface detected — excluded.", recommendation:null, evidence:"no mcp keywords" });
  else {
    const mcpProbe = await fetchWithTimeout(ORIGIN + "/.well-known/mcp/server-card.json");
    const pass = mcpProbe.status === 200;
    recommended.push({
      id:"recommended-mcp", name:"MCP server discovery", tier:"recommended",
      result: pass ? "passed" : "partial",
      details: pass ? "MCP server-card discoverable." : `MCP mentioned but no card at /.well-known/mcp/server-card.json (${mcpProbe.status}).`,
      recommendation: pass ? null : "Publish MCP server card at /.well-known/mcp/server-card.json or /mcp/server-card per is-agentic spec.",
      evidence: `GET /.well-known/mcp/server-card.json → ${mcpProbe.status}`,
    });
  }
}

// R05 Commerce
{
  const applicable = surfaces.commerce;
  if (!applicable) recommended.push({ id:"recommended-commerce", name:"Commerce agent use", tier:"recommended", result:"not_applicable", details:"No commerce surface detected — excluded.", recommendation:null, evidence:"no shop/cart keywords" });
  else {
    const hasStructured = /application\/ld\+json/i.test(html) && /product/i.test(htmlLowerForDetect);
    recommended.push({
      id:"recommended-commerce", name:"Commerce structured data", tier:"recommended",
      result: hasStructured ? "passed" : "partial",
      details: hasStructured ? "Product structured data (JSON-LD) found." : "Commerce keywords found but no Product JSON-LD detected.",
      recommendation: hasStructured ? null : "Add schema.org Product JSON-LD with price/availability so agents can understand offers.",
      evidence: `has JSON-LD Product: ${hasStructured}`,
    });
  }
}

// R06 Developer portal
{
  const applicable = surfaces.devportal;
  if (!applicable) recommended.push({ id:"recommended-developer-portal", name:"Developer portal", tier:"recommended", result:"not_applicable", details:"No developer portal signal — excluded.", recommendation:null, evidence:"no developer/docs keywords" });
  else {
    const pass = docsProbe.status === 200;
    recommended.push({
      id:"recommended-developer-portal", name:"Developer portal", tier:"recommended",
      result: pass ? "passed" : "partial",
      details: pass ? "/docs is reachable (200)." : `/docs → ${docsProbe.status}. Link docs from homepage footer/nav.`,
      recommendation: pass ? null : "Publish developer docs at /docs and link them from the homepage. Agents look there first.",
      evidence: `GET /docs → ${docsProbe.status}`,
    });
  }
}

// --- Bonus checks (+5 cap) ---
let bonusPoints = 0;
let positiveSignals = 0;
const bonus = [];

let llms = await fetchWithTimeout(ORIGIN + "/llms.txt");
{
  const pass = llms.status === 200 && llms.body.length > 50;
  if (pass) { bonusPoints += 1.2; positiveSignals++; }
  bonus.push({ id:"bonus-llms-txt", name:"llms.txt", tier:"bonus", result: pass ? "passed" : "not_applicable", details: pass ? "/llms.txt found." : `/llms.txt → ${llms.status}`, recommendation: pass?null:"Consider adding /llms.txt (machine-readable site guide) per is-agentic.", evidence:`GET /llms.txt → ${llms.status}` });
}
{
  const pass = openapiProbe.status === 200;
  if (pass) { bonusPoints += 1.2; positiveSignals++; }
  bonus.push({ id:"bonus-openapi", name:"OpenAPI description", tier:"bonus", result: pass ? "passed":"not_applicable", details: pass? "openapi.json found.": `openapi.json → ${openapiProbe.status}`, recommendation:null, evidence:`GET /openapi.json → ${openapiProbe.status}` });
}
{
  const catalog = await fetchWithTimeout(ORIGIN + "/.well-known/api-catalog");
  const pass = catalog.status === 200;
  if (pass) { bonusPoints += 1.2; positiveSignals++; }
  bonus.push({ id:"bonus-api-catalog", name:"RFC 9727 API catalog", tier:"bonus", result: pass?"passed":"not_applicable", details: pass?"api-catalog found.":`api-catalog → ${catalog.status}`, recommendation:null, evidence:`GET /.well-known/api-catalog → ${catalog.status}` });
}
{
  const mcpCard = await fetchWithTimeout(ORIGIN + "/.well-known/mcp/server-card.json");
  const altCard = mcpCard.status !== 200 ? await fetchWithTimeout(ORIGIN + "/mcp/server-card") : { status: 200 };
  const pass = mcpCard.status === 200 || altCard.status === 200;
  if (pass) { bonusPoints += 1.2; positiveSignals++; }
  bonus.push({ id:"bonus-mcp-card", name:"MCP server card", tier:"bonus", result: pass?"passed":"not_applicable", details: pass?"MCP card found.":`mcp card → ${mcpCard.status}/${altCard.status}`, recommendation:null, evidence:`GET /.well-known/mcp/server-card.json → ${mcpCard.status}` });
}
{
  const pass = sitemap.status === 200;
  if (pass) { bonusPoints += 0.5; positiveSignals++; } // smaller bonus, they already get essential credit
  bonus.push({ id:"bonus-sitemap", name:"Sitemap bonus", tier:"bonus", result: pass?"passed":"not_applicable", details: pass?"sitemap.xml bonus signal.":`sitemap → ${sitemap.status}`, recommendation:null, evidence:`GET /sitemap.xml → ${sitemap.status}` });
}
bonusPoints = Math.min(5, Math.round(bonusPoints*10)/10);

// ---------- scoring ----------
function scorePool(checks, pool) {
  const applicable = checks.filter(c => c.result !== "not_applicable");
  if (applicable.length === 0) return { earned: pool, available: pool, passing: 0, total: 0, pct: 1 }; // excluded pool = full credit (not penalized)
  // Actually per methodology: not-applicable are excluded, not counted. So if no applicable, pool is not counted → treat as 0 available.
  // To match is-agentic display: show 0/0 but not penalize total. We'll return available = 0.
  // For scoring: if pool excluded, it contributes 0 to total, not full.
}

let essentialApplicable = essential.filter(c => c.result !== "not_applicable");
let recApplicable = recommended.filter(c => c.result !== "not_applicable");

// Essential: 80 pool distributed equally
let essentialEarned = 0;
for (const c of essential) {
  if (c.result === "passed") essentialEarned += 80 / essential.length;
  else if (c.result === "partial") essentialEarned += 40 / essential.length;
}
essentialEarned = Math.round(essentialEarned*10)/10;

// Recommended: 20 pool distributed over applicable only
let recEarned = 0;
let recAvailable = recApplicable.length > 0 ? 20 : 0;
if (recApplicable.length > 0) {
  for (const c of recApplicable) {
    if (c.result === "passed") recEarned += 20 / recApplicable.length;
    else if (c.result === "partial") recEarned += 10 / recApplicable.length;
  }
  recEarned = Math.round(recEarned*10)/10;
}

let totalScore = Math.min(100, Math.round((essentialEarned + recEarned + bonusPoints)*10)/10);
if (recApplicable.length === 0) {
  // rescale to 100 when no recommended pool applies: score = essential/80*100 + bonus
  // But methodology says essential is 80 pool, recommended 20 — if no recommended, you can still get 80 + bonus = 85 max?
  // Docs say "Checks that do not apply are excluded rather than counted as failures, so a public website is not penalized"
  // Means totalScore is sum of pools that apply. We'll keep as sum, so max 85 if no rec surface. That's intentional — simple site shouldn't need API.
  // For friendlier display we also show scaled-to-100 alternative in note.
}
const essentialPassing = essential.filter(c=>c.result==="passed").length;
const recPassing = recApplicable.filter(c=>c.result==="passed").length;

// issues are failed + partial (like is-agentic)
const issues = [...essential, ...recommended].filter(c => c.result==="failed" || c.result==="partial").map(c=> ({
  id: c.id, name: c.name, tier: c.tier, result: c.result, details: c.details, recommendation: c.recommendation
}));

// ---------- output ----------
const report = {
  target: TARGET,
  display_target: new URL(TARGET).host,
  report_url: `local://audit/${new URL(TARGET).host} (private — not published)`,
  score: totalScore,
  score_label: scoreLabel(totalScore),
  scanned_at: new Date().toISOString(),
  eligible_checks: essentialApplicable.length + recApplicable.length,
  score_breakdown: {
    essential: { earned: essentialEarned, available: 80, passing: essentialPassing, total: essential.length },
    recommended: { earned: recEarned, available: recAvailable, passing: recPassing, total: recApplicable.length },
    bonus: { points: bonusPoints, positive_signals: positiveSignals },
  },
  issues,
  // extra local detail not in public API
  _local: {
    version: VERSION,
    origin: ORIGIN,
    duration_ms: Date.now() - started,
    surfaces_detected: surfaces,
    all_checks: [...essential, ...recommended, ...bonus],
    note: "Private audit — no data sent to is-agentic.com. Score model mirrors https://is-agentic.com/methodology (Essential 80 + Recommended 20 + Bonus 5). Not-applicable recommended checks are excluded, not failed.",
    privacy: "This report was generated locally and was NOT published. is-agentic.com would publish at https://is-agentic.com/scan/<host> forever.",
  }
};

if (wantJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const maxPossible = 80 + recAvailable + 5;
  console.log(`  ${bar(totalScore)}  ${totalScore} / 100 ${totalScore>maxPossible? "(capped)": maxPossible<100?` (max ${maxPossible} — no rec surface, not penalized)`:""}`);
  console.log(`  ${report.score_label}  ·  ${issues.filter(i=>i.result==="failed").length} failed · ${issues.filter(i=>i.result==="partial").length} partial  ·  ${Date.now()-started}ms\n`);
  console.log(`SCORE BREAKDOWN`);
  console.log(`  Essential     ${essentialEarned.toFixed(1)} / 80    ${essentialPassing} / ${essential.length} passed`);
  if (recApplicable.length > 0) console.log(`  Recommended   ${recEarned.toFixed(1)} / 20    ${recPassing} / ${recApplicable.length} passed`);
  else console.log(`  Recommended    0.0 / 20    (no API/OAuth/GraphQL/MCP/commerce detected — excluded, not penalized)`);
  console.log(`  Bonus            +${bonusPoints}    ${positiveSignals} positive signals (cap 5)\n`);

  if (surfaces.api || surfaces.oauth || surfaces.graphql || surfaces.mcp || surfaces.commerce || surfaces.devportal) {
    console.log(`DETECTED SURFACES (conditional scoring active):`);
    Object.entries(surfaces).forEach(([k,v])=> { if(v) console.log(`  • ${k}`); });
    console.log("");
  }

  const fails = issues.filter(i=>i.result==="failed");
  const partials = issues.filter(i=>i.result==="partial");
  if (fails.length) {
    console.log(`FAILURES (${fails.length})`);
    fails.forEach((f,i)=>{
      console.log(`\n${i+1}. FAIL · ${f.tier.toUpperCase()}  ${f.name}  (${f.id})`);
      console.log(`   Evidence  ${f.details}`);
      if (f.recommendation) console.log(`   Fix       ${f.recommendation}`);
    });
    console.log("");
  }
  if (partials.length) {
    console.log(`PARTIALS (${partials.length})`);
    partials.forEach((f,i)=>{
      console.log(`\n${i+1}. PARTIAL · ${f.tier.toUpperCase()}  ${f.name}`);
      console.log(`   Evidence  ${f.details}`);
      if (f.recommendation) console.log(`   Fix       ${f.recommendation}`);
    });
    console.log("");
  }
  if (!fails.length && !partials.length) {
    console.log("No failures — strong baseline. Consider bonus signals for extra credit:\n  • /llms.txt  • /openapi.json  • /.well-known/api-catalog  • /.well-known/mcp/server-card.json\n");
  }

  if (bonusPoints > 0) {
    console.log(`BONUS SIGNALS (+${bonusPoints}):`);
    bonus.filter(b=>b.result==="passed").forEach(b=> console.log(`  + ${b.name}: ${b.details}`));
    console.log("");
  }

  console.log(`PRIVACY NOTE`);
  console.log(`  This audit ran locally and was NOT sent to is-agentic.com.`);
  console.log(`  If you had used https://is-agentic.com, the report would be public forever at:`);
  console.log(`  https://is-agentic.com/scan/${new URL(TARGET).host}\n`);
  console.log(`JSON: node auditor.mjs ${TARGET} --json | jq .`);
  console.log(`Docs: https://is-agentic.com/methodology  (Essential 80 + Recommended 20 + Bonus 5)\n`);
}

process.exit(0);
