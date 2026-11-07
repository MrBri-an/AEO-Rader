'use strict';
/**
 * Scan orchestration + scoring engine.
 *
 * Pipeline per question:
 *   question → provider answer → mention extraction → position rank →
 *   sentence sentiment → source (domain) extraction
 *
 * Then aggregated into per-brand share of voice and, for the tracked brand,
 * a 0–100 visibility score + grade + prioritized recommendations.
 */
const { buildQuestionBank } = require('./questions');
const { answer } = require('./providers');

// ── mention extraction ──────────────────────────────────────────────────────
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find tracked brands in text. Returns firstIndex (char offset of first
 * occurrence) so relative position can be ranked per answer.
 */
function extractMentions(text, brands) {
  const mentions = {};
  for (const b of brands) {
    if (!b) continue;
    const re = new RegExp('\\b' + escapeRe(b) + '\\b', 'i');
    const m = re.exec(text);
    mentions[b] = m ? { found: true, firstIndex: m.index } : { found: false, firstIndex: -1 };
  }
  return mentions;
}

function extractSources(text) {
  const out = new Set();
  const urlRe = /(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
  // Only trust explicit URL-ish tokens or the Sources: line to avoid
  // counting product names that look like domains.
  const sourcesIdx = text.toLowerCase().lastIndexOf('sources:');
  const scope = sourcesIdx >= 0 ? text.slice(sourcesIdx) : text;
  let m;
  while ((m = urlRe.exec(scope))) {
    const host = m[1].toLowerCase();
    // require a plausible TLD (≥2 chars) so "e.g" / "u.s" don't count as domains
    const tld = host.slice(host.lastIndexOf('.') + 1);
    if (tld.length >= 2 && /^[a-z]+$/.test(tld)) out.add(host);
  }
  return [...out];
}

// ── sentiment ───────────────────────────────────────────────────────────────
const POS = ['great', 'excellent', 'best', 'strong', 'reliable', 'affordable', 'robust',
  'intuitive', 'popular', 'leading', 'top', 'recommend', 'worth', 'love', 'powerful',
  'seamless', 'polished', 'generous', 'responsive', 'stands out', 'easier', 'closing the gap'];
const NEG = ['expensive', 'slow', 'buggy', 'limited', 'confusing', 'poor', 'lacking', 'weak',
  'overpriced', 'clunky', 'outdated', 'concerns', 'issues', 'missing', 'complaints', 'steep', 'basic'];

/** Sentiment of the sentence containing the brand's first mention. */
function sentenceSentiment(text, index) {
  if (index < 0) return 0;
  const start = Math.max(text.lastIndexOf('.', index), text.lastIndexOf('\n', index)) + 1;
  const end = text.indexOf('.', index);
  const sentence = text.slice(start, end === -1 ? undefined : end + 1).toLowerCase();
  let score = 0;
  for (const w of POS) if (sentence.includes(w)) score += 1;
  for (const w of NEG) if (sentence.includes(w)) score -= 1;
  return score / (1 + Math.abs(score)); // squash to -1..1
}

/** Normalize a domain to its registrable-ish form for grouping. */
function domainKey(host) {
  return host.replace(/^www\./, '').toLowerCase();
}

// ── per-question analysis ───────────────────────────────────────────────────
function analyzeAnswer(question, answerText, config) {
  const self = config.brand;
  const compNames = (config.competitors || []).map((c) => c.name);
  const all = [self, ...compNames];

  const mentions = extractMentions(answerText, all);
  const sources = extractSources(answerText).map(domainKey);

  const mentionedBrands = all
    .filter((b) => mentions[b] && mentions[b].found)
    .sort((a, b) => mentions[a].firstIndex - mentions[b].firstIndex);

  const position = mentionedBrands.indexOf(self) + 1; // 0 = absent, 1 = first
  const sentiment = sentenceSentiment(answerText, mentions[self] && mentions[self].found ? mentions[self].firstIndex : -1);

  const selfDomain = domainKey(config.domain || '');
  const selfCited = sources.some((s) => s === selfDomain || s.endsWith('.' + selfDomain));

  return {
    questionId: question.id,
    intent: question.intent,
    question: question.text,
    mentionedBrands,
    mentions: all.map((b) => ({ brand: b, found: mentions[b].found, firstIndex: mentions[b].firstIndex })),
    position, // 0 = absent
    sentiment,
    sources,
    selfCited,
  };
}

// ── aggregation ─────────────────────────────────────────────────────────────
function computeScores(analyses, config) {
  const self = config.brand;
  const total = analyses.length || 1;

  const mentioned = analyses.filter((a) => a.position > 0);
  const mentionRate = mentioned.length / total;
  const avgPosition = mentioned.length
    ? mentioned.reduce((s, a) => s + a.position, 0) / mentioned.length
    : 0;
  const positionScore = mentioned.length
    ? mentioned.reduce((s, a) => s + (1 - Math.min(a.position - 1, 4) / 4), 0) / mentioned.length
    : 0;
  const sentimentAvg = mentioned.length
    ? mentioned.reduce((s, a) => s + a.sentiment, 0) / mentioned.length
    : 0;
  const sentiment01 = (sentimentAvg + 1) / 2;
  const citedCount = analyses.filter((a) => a.selfCited).length;
  const sourceScore = Math.min(1, citedCount / 6);

  const visibility = Math.round(
    100 * (0.4 * mentionRate + 0.3 * positionScore + 0.2 * sentiment01 + 0.1 * sourceScore)
  );
  const grade =
    visibility >= 85 ? 'A' : visibility >= 75 ? 'B+' : visibility >= 65 ? 'B' :
    visibility >= 55 ? 'C' : visibility >= 45 ? 'D' : 'F';

  // Share of voice: mention weighted by position (first = full weight).
  const sovWeights = {};
  for (const b of [self, ...(config.competitors || []).map((c) => c.name)]) sovWeights[b] = 0;
  for (const a of analyses) {
    a.mentionedBrands.forEach((b, i) => {
      if (b in sovWeights) sovWeights[b] += 1 / (i + 1);
    });
  }
  const sovTotal = Object.values(sovWeights).reduce((s, w) => s + w, 0) || 1;
  const shareOfVoice = Object.fromEntries(
    Object.entries(sovWeights).map(([b, w]) => [b, Math.round((w / sovTotal) * 100)])
  );

  // Per-intent breakdown for the tracked brand.
  const byIntent = {};
  for (const a of analyses) {
    byIntent[a.intent] = byIntent[a.intent] || { total: 0, present: 0, positionSum: 0 };
    byIntent[a.intent].total += 1;
    if (a.position > 0) {
      byIntent[a.intent].present += 1;
      byIntent[a.intent].positionSum += a.position;
    }
  }

  return {
    visibility,
    grade,
    mentionRate: Math.round(mentionRate * 100),
    avgPosition: Number(avgPosition.toFixed(2)),
    sentiment: Number(sentimentAvg.toFixed(2)),
    citedCount,
    shareOfVoice,
    byIntent,
  };
}

// ── recommendations ─────────────────────────────────────────────────────────
function buildRecommendations(analyses, scores, config) {
  const recs = [];
  const self = config.brand;
  const total = analyses.length || 1;
  const absent = analyses.filter((a) => a.position === 0);

  if (absent.length > 0) {
    const intents = [...new Set(absent.map((a) => a.intent))];
    recs.push({
      priority: absent.length / total > 0.4 ? 'high' : 'medium',
      title: `You're absent from ${absent.length} of ${total} AI answers`,
      detail:
        `Missing mostly from "${intents.join('", "')}" questions. Publish structured comparison content ` +
        `(${self} vs. each competitor), add an llms.txt and FAQ schema, and keep your docs public — ` +
        `models favor content that directly answers buyer questions.`,
    });
  }

  // Who beats us in head-to-head questions?
  const duels = analyses.filter((a) => a.intent === 'comparison' && a.position > 1);
  if (duels.length) {
    const beatenBy = {};
    for (const a of duels) {
      const ahead = a.mentionedBrands.filter((b) => b !== self && a.mentionedBrands.indexOf(b) < a.position - 1);
      ahead.forEach((b) => (beatenBy[b] = (beatenBy[b] || 0) + 1));
    }
    const worst = Object.entries(beatenBy).sort((a, b) => b[1] - a[1])[0];
    if (worst) {
      recs.push({
        priority: 'high',
        title: `${worst[0]} outranks you in ${worst[1]} head-to-head answer${worst[1] > 1 ? 's' : ''}`,
        detail:
          `Create a dedicated "${self} vs ${worst[0]}" page with an honest comparison table, migration guide, ` +
          `and pricing comparison. AI models heavily cite pages that address both brand names in one document.`,
      });
    }
  }

  // Cited sources we're missing.
  const competitorCited = new Map();
  for (const a of analyses) {
    for (const s of a.sources) {
      if (!a.selfCited) competitorCited.set(s, (competitorCited.get(s) || 0) + 1);
    }
  }
  const topDomains = [...competitorCited.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topDomains.length) {
    recs.push({
      priority: 'medium',
      title: `Get listed where models look: ${topDomains.map((d) => d[0]).join(', ')}`,
      detail:
        `These domains appear in answers where you're cited ${config.domain ? 'rarely or never' : 'less often'}. ` +
        `Prioritize G2/Capterra profiles, relevant subreddit presence, and a Product Hunt launch — ` +
        `review platforms are the most-cited source class in AI answers.`,
    });
  }

  // Pricing answers with negative sentiment.
  const pricingNeg = analyses.filter((a) => a.intent === 'pricing' && a.position > 0 && a.sentiment < -0.05);
  if (pricingNeg.length) {
    recs.push({
      priority: 'medium',
      title: 'Pricing perception is negative in AI answers',
      detail:
        'Make the public pricing page unambiguous (per-seat, tiers, free-plan limits). Models repeat ' +
        'unclear pricing language and buyers repeat the model.',
    });
  }

  // Position matters even when present.
  const latePresent = analyses.filter((a) => a.position > 2);
  if (latePresent.length >= 3) {
    recs.push({
      priority: 'medium',
      title: `You appear after position 2 in ${latePresent.length} answers`,
      detail:
        'First mention wins most of the click. Strengthen "best-of" signals: review velocity, ' +
        'listicle placements, and a category-defining landing page ("best X for Y").',
    });
  }

  if (!recs.length) {
    recs.push({
      priority: 'low',
      title: 'Strong visibility across the board',
      detail: 'Keep monitoring weekly — AI answer composition shifts with each model update. Set up the MCP server so agents can watch it for you.',
    });
  }
  return recs;
}

// ── scan runner ─────────────────────────────────────────────────────────────
/**
 * @param {object} config   brand config
 * @param {string} provider demo | openai | anthropic
 * @param {(e:{type:string, [k:string]:any})=>void} onEvent progress callback
 * @returns {Promise<object>} completed run
 */
async function runScan(config, provider, onEvent) {
  const emit = onEvent || (() => {});
  const questions = buildQuestionBank(config);
  const startedAt = Date.now();

  const analyses = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    emit({ type: 'progress', index: i, total: questions.length, question: q.text, id: q.id });
    try {
      // pass the locally-stored key (config.apiKeys) through; providers fall back to env vars
      const key = config.apiKeys && config.apiKeys[provider];
      const { text, model } = await answer(provider, { ...q, key }, config);
      analyses.push(analyzeAnswer(q, text, config));
      emit({ type: 'answer', id: q.id, ok: true });
      // stash the raw answer for UI display (attach below)
      analyses[analyses.length - 1].answerText = text;
      if (model) analyses[analyses.length - 1].model = model;
    } catch (err) {
      analyses.push({
        questionId: q.id,
        intent: q.intent,
        question: q.text,
        error: String(err.message || err),
        mentionedBrands: [],
        mentions: [],
        position: 0,
        sentiment: 0,
        sources: [],
        selfCited: false,
      });
      emit({ type: 'answer', id: q.id, ok: false, error: String(err.message || err) });
    }
  }

  const scores = computeScores(analyses, config);
  const recommendations = buildRecommendations(analyses, scores, config);

  return {
    id: 'run_' + startedAt.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    ts: new Date().toISOString(),
    provider,
    model: provider === 'demo' ? 'sim-engine' : null,
    config: {
      brand: config.brand,
      domain: config.domain,
      category: config.category,
      audience: config.audience,
      competitors: config.competitors,
    },
    scores,
    recommendations,
    analyses,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = { runScan, analyzeAnswer, computeScores, buildRecommendations, buildQuestionBank };
