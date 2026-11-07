'use strict';
/**
 * Answer providers.
 *  - demo:      deterministic simulated AI-search answers (no network, no key)
 *  - groq:      Groq OpenAI-compatible endpoint (GROQ_API_KEY / GROQ_MODEL)
 *  - openai:    OpenAI Chat Completions (OPENAI_API_KEY / OPENAI_MODEL)
 *  - anthropic: Anthropic Messages API (ANTHROPIC_API_KEY / ANTHROPIC_MODEL)
 *
 * All providers return { text } — the same parser/scorer consumes the output,
 * so demo runs exercise the identical pipeline as live runs.
 */

const SYSTEM_PROMPT =
  'You are a neutral AI search assistant answering a buyer researching a purchase, ' +
  'the way ChatGPT or Perplexity would answer. Be concrete: name specific products, ' +
  'rank them when asked for the best, give pros and cons, and finish with a ' +
  "'Sources:' section listing a few relevant URLs.";

// ── shared HTTP call for real providers (retries 429/5xx with backoff) ─────
const BACKOFF_MS = [2000, 6000, 14000];

async function fetchJson(url, options, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res.json();
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (_) { /* ignore */ }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`${res.status} ${res.statusText} ${detail}`);
  }
}

// ── deterministic PRNG helpers ──────────────────────────────────────────────
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── demo answer vocabulary ──────────────────────────────────────────────────
const PRAISE = [
  'polished onboarding', 'excellent automation', 'great value for the price',
  'intuitive interface', 'responsive support team', 'strong reporting',
  'generous free tier', 'quick setup',
];
const BALANCED = [
  'solid core features', 'a short learning curve', 'steady release cadence',
  'decent analytics', 'reliable day-to-day',
];
const MILD = [
  'can feel limited at scale', 'pricing gets steep on higher tiers',
  'support can be slow during peak times', 'reporting is fairly basic',
];
const UNTRACKED_NAMES = ['Zoho', 'Monday.com', 'Freshsales', 'Copper'];
const SOURCE_POOL = [
  'g2.com', 'reddit.com', 'trustpilot.com', 'capterra.com', 'techradar.com',
  'forbes.com', 'producthunt.com', 'medium.com', 'pcmag.com', 'zapier.com',
];

function pick(rand, arr, k) {
  const copy = arr.slice();
  const out = [];
  while (out.length < k && copy.length) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return out;
}

function brandLine(rand, affinity, name) {
  const tone = affinity > 0.66 ? PRAISE : affinity > 0.4 ? BALANCED : MILD;
  const bits = pick(rand, tone, 2);
  const verb = affinity > 0.66 ? 'stands out for' : affinity > 0.4 ? 'is known for' : 'gets mentioned for';
  return `${name} ${verb} ${bits[0]} and ${bits[1]}.`;
}

function demoAnswer(question, ctx) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const rand = mulberry32(fnv1a(question.text + '|' + ctx.brand + '|' + dayKey));

  const tracked = [
    { name: ctx.brand, domain: ctx.domain, isSelf: true },
    ...(ctx.competitors || []).map((c) => ({ name: c.name, domain: c.domain, isSelf: false })),
  ];
  // Per-question affinity: self gets a slight underdog bias so the
  // recommendations engine has honest work to do in demo mode.
  const scored = tracked.map((b) => ({
    ...b,
    affinity: b.isSelf ? 0.3 + rand() * 0.5 : 0.15 + rand() * 0.8,
  }));

  const q = question.text;
  const isBrandQ = q.toLowerCase().includes(ctx.brand.toLowerCase());
  const altTarget = /alternatives to ([a-z0-9. ]+)\??$/i.exec(q);

  let present;
  if (question.intent === 'brand' || question.intent === 'pricing') {
    // Subject-of-the-question answers: the named brand is always present,
    // competitors sometimes get pulled in for contrast.
    present = scored.filter((b) => b.isSelf || rand() > 0.55);
  } else if (altTarget) {
    const target = altTarget[1].trim().toLowerCase();
    present = scored.filter((b) => b.name.toLowerCase() !== target && b.affinity > 0.42);
    if (!present.length) present = scored.filter((b) => b.name.toLowerCase() !== target).slice(0, 2);
  } else {
    present = scored.filter((b) => b.affinity > 0.45);
  }
  present.sort((a, b) => b.affinity - a.affinity);

  const parts = [];

  if (question.intent === 'list' || question.intent === 'howto') {
    parts.push(
      `Here are the ${ctx.category} options I'd shortlist for ${ctx.audience || 'small businesses'}:`
    );
    present.forEach((b, i) => parts.push(`${i + 1}. ${b.name} — ${brandLine(rand, b.affinity, b.name)}`));
    // realistic touch: an untracked name sometimes slips into lists
    if (rand() > 0.5) {
      const stray = pick(rand, UNTRACKED_NAMES, 1)[0];
      parts.push(`Worth a look as well: ${stray}, depending on your budget.`);
    }
    parts.push(
      question.intent === 'howto'
        ? `When choosing, prioritize integrations, data export and per-seat pricing over feature checklists.`
        : `All of these have free trials, so it's worth testing the top two with your own pipeline.`
    );
  } else if (question.intent === 'comparison') {
    const other = present.find((b) => !b.isSelf) || scored.find((b) => !b.isSelf);
    const self = present.find((b) => b.isSelf);
    parts.push(`It depends on what you're optimizing for, but here's the honest breakdown:`);
    if (self) parts.push(brandLine(rand, self.affinity, self.name));
    if (other) parts.push(brandLine(rand, other.affinity, other.name));
    parts.push(
      self && self.affinity > other.affinity
        ? `For most small teams, ${ctx.brand} is the easier starting point; ${other ? other.name : 'the alternatives'} makes more sense once you need enterprise process depth.`
        : `For most teams, ${other ? other.name : 'the incumbent'} is the safer default today, though ${ctx.brand} is closing the gap on integrations.`
    );
  } else if (question.intent === 'pricing') {
    const tiers = 2 + Math.floor(rand() * 3);
    const base = 9 + Math.floor(rand() * 30);
    parts.push(
      `${ctx.brand} uses per-seat pricing with roughly ${tiers} tiers, starting around $${base}/user/month for the entry plan.`
    );
    parts.push(
      rand() > 0.4
        ? `There is a limited free plan — fine for solo use, but automation and reporting kick in on paid tiers.`
        : `There's a free trial, but no permanent free plan, which surprises a few buyers.`
    );
    parts.push(`Annual billing typically discounts the monthly rate by about 15–20%.`);
  } else {
    // brand review
    const self = scored.find((b) => b.isSelf);
    const overall = self.affinity > 0.6 ? 'mostly positive' : 'mixed but trending positive';
    parts.push(`User feedback on ${ctx.brand} is ${overall}.`);
    parts.push(brandLine(rand, self.affinity, ctx.brand));
    if (self.affinity < 0.6) {
      parts.push(`Common complaints mention ${pick(rand, MILD, 1)[0]}, especially at scale.`);
    }
    parts.push(`Most reviewers say it earns its place if ${ctx.category.toLowerCase()} is central to your workflow.`);
  }

  // Sources block — mix of review sites and occasionally brand domains.
  const domains = pick(rand, SOURCE_POOL, 1 + Math.floor(rand() * 3)).slice();
  if (rand() > 0.6) domains.push(ctx.domain);
  if (rand() > 0.75 && present.find((b) => !b.isSelf)) domains.push(present.find((b) => !b.isSelf).domain);
  parts.push(`Sources: ${domains.map((d) => `https://${d}`).join(', ')}`);

  return { text: parts.join('\n') };
}

// ── live providers ──────────────────────────────────────────────────────────
async function groqAnswer(question) {
  const key = question.key;
  if (!key) throw new Error('Missing Groq API key');
  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const data = await fetchJson('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question.text },
      ],
    }),
  });
  return { text: data.choices[0].message.content, model };
}

async function openaiAnswer(question) {
  const key = question.key;
  if (!key) throw new Error('Missing OpenAI API key');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question.text },
      ],
    }),
  });
  return { text: data.choices[0].message.content, model };
}

async function anthropicAnswer(question) {
  const key = question.key;
  if (!key) throw new Error('Missing Anthropic API key');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const data = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: question.text }],
      system: SYSTEM_PROMPT,
    }),
  });
  return { text: data.content.map((c) => (c.text || '')).join(''), model };
}

/**
 * Answer one question with the requested provider.
 * @returns {Promise<{text:string, model?:string}>}
 */
async function answer(provider, question, config) {
  if (provider === 'groq') return groqAnswer({ ...question, key: question.key || process.env.GROQ_API_KEY });
  if (provider === 'openai') return openaiAnswer({ ...question, key: question.key || process.env.OPENAI_API_KEY });
  if (provider === 'anthropic') return anthropicAnswer({ ...question, key: question.key || process.env.ANTHROPIC_API_KEY });
  return demoAnswer(question, config);
}

module.exports = { answer, SYSTEM_PROMPT, fnv1a, mulberry32 };
