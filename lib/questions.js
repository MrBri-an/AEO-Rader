'use strict';
/**
 * Buyer-intent question bank.
 * These mirror the questions real buyers type into ChatGPT / Perplexity /
 * Google AI when researching a purchase. Coverage across intents is what
 * makes the visibility score meaningful instead of vanity.
 */

function audienceClause(audience) {
  return audience && audience.trim() ? audience.trim() : 'small businesses';
}

/**
 * @param {{brand:string, domain:string, category:string, audience:string,
 *          competitors:{name:string,domain:string}[]}} config
 * @returns {{id:string, intent:string, text:string}[]}
 */
function buildQuestionBank(config) {
  const brand = config.brand;
  const category = config.category || 'this product category';
  const aud = audienceClause(config.audience);
  const comps = (config.competitors || []).filter((c) => c && c.name).slice(0, 4);
  const out = [];
  let n = 0;
  const push = (intent, text) => out.push({ id: 'q' + ++n, intent, text });

  // ── List intent: "best X" discovery answers ─────────────────────────────
  push('list', `What are the best ${category} tools right now?`);
  push('list', `Which ${category} platforms would you recommend for ${aud}?`);
  push('list', `Top ${category} options this year?`);
  push('list', `Best ${category} solutions for small teams?`);

  // ── Comparison intent: head-to-heads and alternatives ───────────────────
  for (const c of comps) {
    push('comparison', `${brand} vs ${c.name} — which is better?`);
    push('comparison', `What are good alternatives to ${c.name} for ${category.toLowerCase()}?`);
  }

  // ── Brand intent: reputation checks ─────────────────────────────────────
  push('brand', `${brand} review — is it any good?`);
  push('brand', `Is ${brand} worth it?`);
  push('brand', `What are the pros and cons of ${brand}?`);
  push('brand', `What do users say about ${brand}?`);
  push('brand', `How does ${brand} compare to other ${category} tools?`);

  // ── Pricing intent ──────────────────────────────────────────────────────
  push('pricing', `How much does ${brand} cost?`);
  push('pricing', `Does ${brand} have a free plan?`);

  // ── How-to / problem intent ─────────────────────────────────────────────
  push('howto', `How do I choose the right ${category} tool?`);
  push('howto', `What should I look for when choosing ${category}?`);
  push('howto', `Why would a business need ${category.toLowerCase()}?`);

  return out;
}

module.exports = { buildQuestionBank };
