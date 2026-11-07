# AEO Radar — AI Search Visibility Tracker

**Measure how your brand appears inside AI-generated answers.** SEO told you where you rank on Google; AEO (Answer Engine Optimization) tells you where you rank when a buyer asks ChatGPT, Perplexity or Claude *"what's the best CRM for a small business?"* — and whether AI cites your domain when it answers.

Zero npm dependencies. Runs on stock Node 18+. Ships with four answer providers:

| Provider | Key needed | Notes |
|---|---|---|
| **Simulation engine** | none | Deterministic demo answers — same scoring pipeline as live providers |
| **Groq** | `gsk_…` | `openai/gpt-oss-120b` on Groq's fast inference (override: `GROQ_MODEL`) |
| **OpenAI** | `sk-…` | `gpt-4o-mini` by default (override: `OPENAI_MODEL`) |
| **Anthropic** | `sk-ant-…` | `claude-sonnet-4-5` by default (override: `ANTHROPIC_MODEL`) |

---

## Quick start

```bash
node server.js
# Dashboard → http://localhost:4173
```

First boot seeds a demo brand (**Nimbus CRM** vs HubSpot/Salesforce/Pipedrive) and runs an initial simulation scan so the dashboard is alive immediately. Change everything in **Setup**, then **Run scan**.

### MCP server (agent access)

Expose visibility data to Claude Desktop, IDE copilots, or any MCP client:

```bash
node mcp-server.js        # stdio JSON-RPC, Model Context Protocol
```

```jsonc
// e.g. claude_desktop_config.json
{ "mcpServers": { "aeo-radar": { "command": "node", "args": ["<path>/aeo-radar/mcp-server.js"] } } }
```

Tools: `aeo_get_report` · `aeo_run_scan` · `aeo_get_history` · `aeo_get_questions` · `aeo_get_config`

---

## What it measures

The question bank probes five buyer intents (20 questions with 3 competitors):

- **List** — "best CRM software right now?"
- **Comparison** — "Nimbus vs HubSpot — which is better?", "alternatives to HubSpot?"
- **Brand** — "is Nimbus CRM worth it?", "what do users say?"
- **Pricing** — "how much does it cost?", "free plan?"
- **How-to** — "how do I choose the right CRM?"

Per answer it extracts:

- **Mention** — is the brand named at all
- **Position** — rank of first mention among tracked brands (first mention wins most of the click)
- **Sentiment** — lexicon score of the sentence containing the first mention
- **Sources** — cited domains (G2, Reddit, Capterra…), and whether *your* domain got cited

### Visibility score (0–100)

```
0.40 × mentionRate + 0.30 × positionScore + 0.20 × sentiment + 0.10 × citationScore
```

Graded A → F, plus **share of voice** (mention share weighted by position) against every competitor, per-intent coverage, a cited-sources table, history trend, CSV export, and rule-based **recommendations** that name the exact competitor outranking you and the domains to get listed on.

---

## Architecture

```
aeo-radar/
├── server.js          zero-dep HTTP server + REST API (NDJSON scan streaming)
├── mcp-server.js      MCP stdio server (JSON-RPC 2.0, five tools)
├── lib/
│   ├── db.js          JSON file store, atomic debounced writes (data/db.json)
│   ├── questions.js   buyer-intent question bank generator
│   ├── providers.js   demo simulation + OpenAI + Anthropic adapters
│   └── engine.js      answer parsing → scoring → recommendations
├── public/            dashboard (vanilla JS, hand-rolled SVG charts)
└── data/db.json       config + last 60 scans (git-ignorable, local only)
```

**Design choices worth stealing:**
- Demo and live providers emit identical shapes, so the whole scoring pipeline is exercised offline and tests never need API keys.
- `/api/scan` streams progress as NDJSON — the UI shows per-question status live without websockets.
- Everything is stdlib: `node:http`, global `fetch` (Node 18+), no build step.

---

## Monetization path (why this product)

1. **Self-serve SaaS** — free scan for one brand; paid tiers unlock scheduling (weekly scans), competitor count, provider breadth, alerts on score drops. Typical AEO/SEO tooling pricing: $29–$99/mo; the buyer is a marketing team, and budget already exists (it's reallocated from legacy rank trackers).
2. **Agency/white-label** — agencies run it per client and put the report in monthly decks; per-seat or per-client pricing.
3. **Report-as-product** — the CSV/PDF export plus MCP access makes the data the deliverable, not the dashboard.

The moat isn't the UI — it's **question-bank quality and history**: visibility is only meaningful when measured consistently against the same buyer intents over time. That's also what vendors in this new category (Profound, Peec AI, etc.) charge for.

## Job-interview talking points

This project demonstrates the exact 2026 hiring bar (agentic AI + AI integration + product sense):

- **MCP implementation from scratch** — JSON-RPC 2.0 over stdio, tool schemas, the protocol every AI agent stack is converging on. Not "used an SDK" — *implemented the protocol*.
- **Multi-provider LLM orchestration** — Groq (OpenAI-compatible), OpenAI, and Anthropic adapters behind one interface, with a deterministic simulation provider so the pipeline is testable without keys.
- **Real-time streaming UX** — NDJSON progress streaming over plain `fetch` + `ReadableStream`, no websocket dependency.
- **Data product thinking** — defensible scoring model (mention × position × sentiment × citations), share-of-voice math, trend analysis, actionable recommendations generated from scan diffs.
- **Zero-dependency discipline** — a full product on `node:http` stdlib: server, static hosting, atomic JSON persistence, CSV export.

---

## Notes & limits

- LLMs can fabricate citations; live-provider source extraction is best-effort and meant for trend signal, not audits.
- API keys entered in Setup are stored in `data/db.json` on your machine only (git-ignored — never committed). Env vars `GROQ_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` also work and take lower precedence than the UI keys.
- Scan pace: simulation is instant; live providers run sequentially (~20 requests), watch the progress bar.
- Reset anytime with **Setup → Reset demo data** (wipes runs, restores demo brand).

## License

MIT — build on it, ship it, sell it.
