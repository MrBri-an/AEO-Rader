'use strict';
/* AEO Radar console — vanilla JS, no deps. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  config: null,
  runs: [],        // summaries, newest first
  run: null,       // latest full run
  scanning: false,
  answerFilter: 'all',
};

/* ── helpers ─────────────────────────────────────────────────────── */
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function gradeClass(grade) {
  return grade.startsWith('A') || grade.startsWith('B') ? '' : grade.startsWith('C') ? 'warn' : 'bad';
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Light cleanup of raw LLM markdown so answers read as evidence, not noise. */
function cleanAnswerText(text) {
  return String(text || '')
    .replace(/\*\*/g, '')                                   // bold markers
    .replace(/<br\s*\/?>/gi, ' · ')                         // <br> in table cells
    .replace(/<\/?[a-z][^>]{0,20}>/gi, '')                  // stray inline tags
    .split('\n')
    .filter((line) => !/^\s*\|?[\s:|-]{6,}\|?\s*$/.test(line)) // table separator rows
    .join('\n');
}

/** Escape text, then wrap tracked-brand mentions in colored <mark>s. */
function highlight(text, config) {
  let html = esc(cleanAnswerText(text));
  const brands = [config.brand, ...(config.competitors || []).map((c) => c.name)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const b of brands) {
    const cls = b === config.brand ? 'm-self' : 'm-comp';
    html = html.replace(new RegExp('\\b(' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'gi'),
      `<mark class="${cls}">$1</mark>`);
  }
  return html;
}

/* ── data loading ────────────────────────────────────────────────── */
async function loadAll() {
  const [config, runsList] = await Promise.all([api('/api/config'), api('/api/runs')]);
  state.config = config;
  state.runs = runsList.runs;
  if (state.runs.length && (!state.run || state.run.id !== state.runs[0].id)) {
    state.run = await api('/api/runs/' + state.runs[0].id);
  }
  if (!state.runs.length) state.run = null;
  renderAll();
}

function renderAll() {
  renderTopbar();
  renderOverview();
  renderScanList();
  renderAnswers();
  renderSources();
  renderActions();
  renderHistory();
  renderSetup();
}

/* ── topbar / provider chip ──────────────────────────────────────── */
function renderTopbar() {
  const c = state.config;
  $('#foot-brand').textContent = c ? `tracking: ${c.brand.toLowerCase()} · ${c.category.toLowerCase()}` : '';
  const chip = $('#provider-chip');
  const label = $('#provider-label');
  const p = c.provider;
  const live = p !== 'demo' && c.hasKeys && c.hasKeys[p];
  chip.className = 'chip' + (live ? ' live' : '');
  label.textContent = live ? `${p} · live` : 'simulation';
  $('#btn-export').style.visibility = state.run ? 'visible' : 'hidden';
}

/* ── overview ────────────────────────────────────────────────────── */
function renderOverview() {
  const run = state.run;
  const els = ['#kpi-visibility', '#kpi-mention', '#kpi-position', '#kpi-sov'].map((s) => $(s));
  if (!run) {
    els.forEach((el) => (el.textContent = '–'));
    $('#kpi-grade').textContent = '–';
    $('#radar').innerHTML = '';
    $('#radar-legend').innerHTML = '';
    $('#sov-bars').innerHTML = '<div class="empty">No scans yet — hit <b>Run scan</b>.</div>';
    $('#intent-coverage').innerHTML = '';
    $('#sources-mini tbody').innerHTML = '';
    $('#trend-wrap').innerHTML = '<div class="trend-empty">Trend appears after two or more scans.</div>';
    return;
  }
  const s = run.scores;
  $('#kpi-visibility').textContent = s.visibility;
  $('#kpi-mention').textContent = s.mentionRate;
  $('#kpi-position').textContent = s.avgPosition || '–';
  $('#kpi-sov').textContent = (s.shareOfVoice && s.shareOfVoice[run.config.brand]) ?? '–';
  const g = $('#kpi-grade');
  g.textContent = s.grade;
  g.className = 'grade ' + gradeClass(s.grade);

  renderRadar(run);
  renderSovBars(run);
  renderIntentCoverage(run);
  renderSourcesMini(run);
  renderTrend('#trend-wrap', [...state.runs].reverse().map((r) => r.scores.visibility), false);
}

function renderRadar(run) {
  const svg = $('#radar');
  const brand = run.config.brand;
  const brands = [brand, ...run.config.competitors.map((c) => c.name)];
  const sov = run.scores.shareOfVoice || {};
  const R = 138, cx = 150, cy = 150;

  let rings = '';
  for (const r of [R, R * 0.66, R * 0.33]) {
    rings += `<circle class="radar-ring" cx="${cx}" cy="${cy}" r="${r}" stroke-width="1"/>`;
  }
  rings += `<line class="radar-cross" x1="${cx - R}" y1="${cy}" x2="${cx + R}" y2="${cy}"/>` +
           `<line class="radar-cross" x1="${cx}" y1="${cy - R}" x2="${cx}" y2="${cy + R}"/>`;

  const sweep =
    `<g class="radar-sweep">
       <defs><linearGradient id="swp" x1="0" y1="0" x2="1" y2="0">
         <stop offset="0" stop-color="#30d158" stop-opacity="0"/>
         <stop offset="1" stop-color="#30d158" stop-opacity="0.16"/>
       </linearGradient></defs>
       <path d="M ${cx} ${cy} L ${cx + R} ${cy} A ${R} ${R} 0 0 0 ${cx + R * Math.cos(-0.6)} ${cy + R * Math.sin(-0.6)} Z" fill="url(#swp)"/>
     </g>`;

  const blips = brands.map((b, i) => {
    const angle = (-90 + (360 / brands.length) * i) * Math.PI / 180;
    const share = Math.max(0, Math.min(100, sov[b] || 0));
    const dist = 16 + ((100 - share) / 100) * (R - 30);
    const x = cx + dist * Math.cos(angle);
    const y = cy + dist * Math.sin(angle);
    const isSelf = b === brand;
    const lx = cx + (dist + 13) * Math.cos(angle);
    const ly = cy + (dist + 13) * Math.sin(angle);
    const anchor = Math.abs(Math.cos(angle)) < 0.3 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
    return `<circle class="radar-blip${isSelf ? ' self' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isSelf ? 4.5 : 3.5}"></circle>
            <text class="radar-blip-label${isSelf ? ' self' : ''}" x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}">${esc(b)}</text>`;
  }).join('');

  svg.innerHTML = rings + sweep + blips + `<circle cx="${cx}" cy="${cy}" r="2" fill="#30d158"/>`;

  $('#radar-legend').innerHTML = brands.map((b) => {
    const isSelf = b === brand;
    return `<div class="lg"><span class="sw" style="background:${isSelf ? 'var(--accent)' : 'var(--comp)'}"></span>${esc(b)}<b>${sov[b] || 0}%</b></div>`;
  }).join('');
}

function renderSovBars(run) {
  const brand = run.config.brand;
  const entries = Object.entries(run.scores.shareOfVoice || {}).sort((a, b) => b[1] - a[1]);
  $('#sov-bars').innerHTML = entries.map(([b, pct]) =>
    `<div class="sov-row${b === brand ? ' self' : ''}">
       <div class="sov-name" title="${esc(b)}">${esc(b)}</div>
       <div class="sov-track"><div class="sov-fill" style="width:${pct}%"></div></div>
       <div class="sov-pct">${pct}%</div>
     </div>`
  ).join('');
}

function renderIntentCoverage(run) {
  const bi = run.scores.byIntent || {};
  const names = { list: 'List intent', comparison: 'Comparisons', brand: 'Brand queries', pricing: 'Pricing', howto: 'How-to' };
  $('#intent-coverage').innerHTML = Object.entries(bi).map(([k, v]) => {
    const pct = v.total ? Math.round((v.present / v.total) * 100) : 0;
    const avgPos = v.present ? (v.positionSum / v.present).toFixed(1) : '–';
    return `<div class="intent-card">
      <div class="ic-name">${names[k] || k}</div>
      <div class="ic-val" style="color:${pct >= 60 ? 'var(--green)' : pct >= 30 ? 'var(--amber)' : 'var(--red)'}">${pct}%</div>
      <div class="ic-sub">${v.present}/${v.total} answers · avg pos ${avgPos}</div>
    </div>`;
  }).join('');
}

function renderSourcesMini(run) {
  const rows = aggregateSources(run).slice(0, 6);
  $('#sources-mini tbody').innerHTML = rows.map((r) =>
    `<tr class="${r.self ? 'you-row' : ''}"><td>${esc(r.domain)}</td><td>${r.count}</td><td class="${r.self ? 'yes' : 'no'}">${r.self ? 'yes' : '—'}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="no">no sources captured</td></tr>';
}

function aggregateSources(run) {
  const selfDomain = (((state.config && state.config.domain) || (run.config && run.config.domain) || '') || '')
    .replace(/^www\./, '').toLowerCase();
  const map = new Map();
  for (const a of run.analyses) {
    for (const d of a.sources || []) {
      const rec = map.get(d) || { domain: d, count: 0, brands: new Set(), self: false };
      rec.count += 1;
      (a.mentionedBrands || []).forEach((b) => rec.brands.add(b));
      if (selfDomain && d === selfDomain) rec.self = true;
      map.set(d, rec);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderTrend(sel, values, labels) {
  const wrap = $(sel);
  if (!values || values.length === 0) {
    wrap.innerHTML = '<div class="trend-empty">Trend appears after two or more scans.</div>';
    return;
  }
  const W = 600, H = labels ? 200 : 130, P = 26;
  const n = values.length;
  const min = Math.min(...values, 0), max = Math.max(...values, 100);
  const x = (i) => P + (n === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (n - 1));
  const y = (v) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);

  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = n > 1 ? `${P},${H - P} ${pts} ${x(n - 1).toFixed(1)},${H - P}` : null;
  const dots = values.map((v, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="#30d158"/>
     <text x="${x(i).toFixed(1)}" y="${(y(v) - 9).toFixed(1)}" text-anchor="middle" font-size="9.5" font-family="ui-monospace, 'SF Mono', Consolas, monospace" fill="rgba(235,235,245,0.5)">${v}</text>`
  ).join('');

  wrap.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
       <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
         <stop offset="0" stop-color="#30d158" stop-opacity="0.2"/>
         <stop offset="1" stop-color="#30d158" stop-opacity="0"/>
       </linearGradient></defs>
       <line x1="${P}" y1="${y(100)}" x2="${W - P}" y2="${y(100)}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4 5"/>
       <line x1="${P}" y1="${y(50)}" x2="${W - P}" y2="${y(50)}" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4 5"/>
       ${area ? `<polygon points="${area}" fill="url(#tg)"/>` : ''}
       <polyline points="${pts}" fill="none" stroke="#30d158" stroke-width="2" stroke-linejoin="round"/>
       ${dots}
     </svg>`;
}

/* ── scan view ───────────────────────────────────────────────────── */
function renderScanList() {
  const run = state.run;
  const list = $('#scan-list');
  if (!run) {
    list.innerHTML = '<div class="empty">Run your first scan to populate the probe list.</div>';
    return;
  }
  const groups = {};
  for (const a of run.analyses) (groups[a.intent] = groups[a.intent] || []).push(a);
  const names = { list: 'List intent', comparison: 'Comparisons', brand: 'Brand queries', pricing: 'Pricing', howto: 'How-to' };
  list.innerHTML = Object.entries(groups).map(([intent, items]) =>
    `<div class="scan-group-head">${names[intent] || intent} — ${items.length}</div>` +
    items.map((a) =>
      `<div class="scan-q ${a.status || (a.error ? 'err' : 'done')}" data-qid="${a.questionId}">
         <span class="st">${a.status ? a.status.toUpperCase() : (a.error ? 'ERROR' : 'DONE')}</span>
         <span class="q-text" title="${esc(a.question)}">${esc(a.question)}</span>
         ${a.status ? '' : `<span class="q-chip ${a.position ? 'hit' : 'miss'}">${a.position ? `pos ${a.position}` : 'absent'}</span>`}
       </div>`
    ).join('')
  ).join('');
}

async function runScan() {
  if (state.scanning) return;
  state.scanning = true;
  setView('scan');
  $('#btn-run-scan').disabled = true;
  $('#scan-status').textContent = 'scanning…';
  $('#scan-note').textContent = 'Probing AI answers in real time — mention, position, sentiment and sources are scored per question.';

  try {
    const res = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok || !res.body) throw new Error('scan request failed');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finished = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'start') {
          state.run = state.run || { analyses: [], config: state.config };
          // fresh statuses
          $('#scan-progress-bar').style.width = '0%';
        } else if (ev.type === 'progress') {
          const row = document.querySelector(`[data-qid="${ev.id}"]`);
          if (row) { row.className = 'scan-q scanning'; row.querySelector('.st').textContent = 'SCANNING'; }
          $('#scan-progress-bar').style.width = `${Math.round((ev.index / ev.total) * 100)}%`;
          $('#scan-status').textContent = `scanning ${ev.index + 1}/${ev.total}`;
        } else if (ev.type === 'answer') {
          const row = document.querySelector(`[data-qid="${ev.id}"]`);
          if (row) {
            row.className = 'scan-q ' + (ev.ok ? 'done' : 'err');
            row.querySelector('.st').textContent = ev.ok ? 'DONE' : 'ERROR';
          }
        } else if (ev.type === 'done') {
          state.run = ev.run;
          finished = true;
        } else if (ev.type === 'error') {
          throw new Error(ev.error);
        }
      }
    }
    if (!finished) throw new Error('scan stream ended early');

    $('#scan-progress-bar').style.width = '100%';
    $('#scan-status').textContent = 'complete';
    await loadAll();
    toast(`Scan complete — visibility ${state.run.scores.visibility}/100 (${state.run.scores.grade})`);
  } catch (err) {
    $('#scan-status').textContent = 'failed';
    toast('Scan failed: ' + err.message, true);
  } finally {
    state.scanning = false;
    $('#btn-run-scan').disabled = false;
    $('#scan-note').textContent = 'Runs the full question bank against the active provider, then scores mentions, position, sentiment and sources.';
  }
}

/* ── answers ─────────────────────────────────────────────────────── */
function renderAnswers() {
  const run = state.run;
  const filters = $('#answer-filters');
  const list = $('#answers-list');
  if (!run) {
    filters.innerHTML = '';
    list.innerHTML = '<div class="empty">No answers yet — run a scan first.</div>';
    return;
  }
  const intents = ['all', ...new Set(run.analyses.map((a) => a.intent))];
  filters.innerHTML = intents.map((i) =>
    `<button class="f-chip${state.answerFilter === i ? ' active' : ''}" data-filter="${i}">${i === 'all' ? 'All' : i}</button>`
  ).join('');

  const items = run.analyses.filter((a) => state.answerFilter === 'all' || a.intent === state.answerFilter);
  list.innerHTML = items.map((a, i) => {
    const sent = a.sentiment;
    return `<div class="ans-card panel" style="animation-delay:${Math.min(i * 0.04, 0.4)}s">
      <div class="ans-head" data-qid="${a.questionId}">
        <div class="ans-pos ${a.position ? '' : 'absent'}">${a.position || '✕'}</div>
        <div class="ans-q">${esc(a.question)}</div>
        <span class="ans-intent">${a.intent}</span>
        <span class="ans-caret">▸</span>
      </div>
      <div class="ans-body">
        ${a.error
          ? `<div class="ans-text" style="color:var(--red)">error: ${esc(a.error)}</div>`
          : `<div class="ans-text">${highlight(a.answerText || '', state.config)}</div>`}
        <div class="ans-meta">
          <span class="meta-chip ${a.position === 1 ? 'good' : ''}">position ${a.position || '—'}</span>
          <span class="meta-chip ${sent > 0.1 ? 'good' : sent < -0.1 ? 'bad' : ''}">sentiment ${sent >= 0 ? '+' : ''}${sent.toFixed(2)}</span>
          ${(a.sources || []).slice(0, 4).map((s) => `<span class="meta-chip">${esc(s)}</span>`).join('')}
          ${a.selfCited ? '<span class="meta-chip good">your domain cited</span>' : ''}
          ${a.model ? `<span class="meta-chip">${esc(a.model)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ── sources ─────────────────────────────────────────────────────── */
function renderSources() {
  const run = state.run;
  const tb = $('#sources-full tbody');
  if (!run) {
    tb.innerHTML = '<tr><td colspan="4" class="no">no scans yet</td></tr>';
    return;
  }
  const rows = aggregateSources(run);
  tb.innerHTML = rows.length
    ? rows.map((r) =>
        `<tr class="${r.self ? 'you-row' : ''}">
           <td>${esc(r.domain)}</td>
           <td>${r.count}</td>
           <td class="no">${[...r.brands].map(esc).join(', ') || '—'}</td>
           <td class="${r.self ? 'yes' : 'no'}">${r.self ? 'cited' : 'not cited'}</td>
         </tr>`).join('')
    : '<tr><td colspan="4" class="no">no sources captured</td></tr>';
}

/* ── actions ─────────────────────────────────────────────────────── */
function renderActions() {
  const run = state.run;
  const list = $('#actions-list');
  const badge = $('#nav-actions-badge');
  if (!run) {
    list.innerHTML = '<div class="empty">Recommendations appear after a scan.</div>';
    badge.hidden = true;
    return;
  }
  const highs = run.recommendations.filter((r) => r.priority === 'high').length;
  badge.hidden = highs === 0;
  badge.textContent = highs;
  list.innerHTML = run.recommendations.map((r, i) =>
    `<div class="panel rec-card" style="animation-delay:${i * 0.06}s">
       <span class="rec-pri ${r.priority}">${r.priority}</span>
       <div><div class="rec-title">${esc(r.title)}</div><div class="rec-detail">${esc(r.detail)}</div></div>
     </div>`
  ).join('');
}

/* ── history ─────────────────────────────────────────────────────── */
function renderHistory() {
  const runs = state.runs;
  renderTrend('#history-chart', runs.length ? [...runs].reverse().map((r) => r.scores.visibility) : [], true);
  const tb = $('#history-table tbody');
  tb.innerHTML = runs.length
    ? runs.map((r) =>
        `<tr><td>${fmtWhen(r.ts)}</td><td>${esc(r.provider)}</td>
         <td><b>${r.scores.visibility}</b>/100</td>
         <td class="${gradeClass(r.scores.grade) === '' ? 'yes' : ''}">${esc(r.scores.grade)}</td>
         <td>${r.scores.mentionRate}%</td><td>${r.scores.avgPosition || '–'}</td></tr>`).join('')
    : '<tr><td colspan="6" class="no">no scans yet</td></tr>';
}

/* ── setup ───────────────────────────────────────────────────────── */
function compRow(c) {
  const div = document.createElement('div');
  div.className = 'comp-row';
  div.innerHTML = `<input name="compName" placeholder="Competitor name" value="${esc(c ? c.name : '')}">
                   <input name="compDomain" placeholder="domain.com" value="${esc(c ? c.domain : '')}">
                   <button type="button" class="rm" title="Remove">×</button>`;
  div.querySelector('.rm').onclick = () => div.remove();
  return div;
}

function renderSetup() {
  const c = state.config;
  if (!c) return;
  const form = $('#setup-form');
  if (document.activeElement && form.contains(document.activeElement)) return; // don't clobber typing
  form.brand.value = c.brand;
  form.domain.value = c.domain || '';
  form.category.value = c.category;
  form.audience.value = c.audience || '';
  const rows = $('#competitor-rows');
  if (!rows.children.length) (c.competitors || []).forEach((x) => rows.appendChild(compRow(x)));

  const pf = $('#provider-form');
  const radio = pf.querySelector(`input[name="provider"][value="${c.provider}"]`);
  if (radio) radio.checked = true;
}

async function saveSetup(e) {
  e.preventDefault();
  const f = $('#setup-form');
  const competitors = [...$('#competitor-rows').children].map((row) => ({
    name: row.querySelector('[name="compName"]').value,
    domain: row.querySelector('[name="compDomain"]').value,
  })).filter((c) => c.name.trim());
  try {
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand: f.brand.value, domain: f.domain.value, category: f.category.value,
        audience: f.audience.value, competitors,
      }),
    });
    renderAll();
    toast('Configuration saved — run a scan to see it reflected');
  } catch (err) {
    toast('Save failed: ' + err.message, true);
  }
}

async function saveProvider(e) {
  e.preventDefault();
  const pf = $('#provider-form');
  const provider = pf.querySelector('input[name="provider"]:checked').value;
  try {
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        apiKeys: {
          groq: pf.groqKey.value.trim(),
          openai: pf.openaiKey.value.trim(),
          anthropic: pf.anthropicKey.value.trim(),
        },
      }),
    });
    renderTopbar();
    toast('Provider saved');
  } catch (err) {
    toast('Save failed: ' + err.message, true);
  }
}

async function resetData() {
  try {
    await api('/api/reset', { method: 'POST' });
    state.run = null;
    await loadAll();
    toast('Demo data reset');
  } catch (err) {
    toast('Reset failed: ' + err.message, true);
  }
}

/* ── view switching & wiring ─────────────────────────────────────── */
const TITLES = {
  overview: ['Overview', 'How AI answers position your brand'],
  scan: ['Scan', 'Buyer-intent probe across the question bank'],
  answers: ['Answers', 'Raw AI answers with tracked-brand mentions'],
  sources: ['Sources', 'Domains that AI answers cite'],
  actions: ['Actions', 'Prioritized moves to raise visibility'],
  history: ['History', 'Visibility over time'],
  setup: ['Setup', 'Brand, competitors and answer provider'],
};

function setView(name) {
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  const [t, sub] = TITLES[name];
  $('#topbar-title').textContent = t;
  $('#topbar-sub').textContent = sub;
  location.hash = name;
}

function wire() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (btn) setView(btn.dataset.view);
  });
  $('#btn-run-scan').addEventListener('click', runScan);
  $('#answers-list').addEventListener('click', (e) => {
    const head = e.target.closest('.ans-head');
    if (head) head.parentElement.classList.toggle('open');
  });
  $('#answer-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.f-chip');
    if (chip) { state.answerFilter = chip.dataset.filter; renderAnswers(); }
  });
  $('#btn-add-competitor').addEventListener('click', () => {
    const rows = $('#competitor-rows');
    if (rows.children.length < 4) rows.appendChild(compRow(null));
  });
  $('#setup-form').addEventListener('submit', saveSetup);
  $('#provider-form').addEventListener('submit', saveProvider);
  $('#btn-reset').addEventListener('click', resetData);
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (v && TITLES[v] && !state.scanning) setView(v);
  });
  const initial = location.hash.slice(1);
  setView(TITLES[initial] ? initial : 'overview');
}

wire();
loadAll().catch((e) => {
  console.error(e);
  toast('Failed to load: ' + e.message, true);
});
