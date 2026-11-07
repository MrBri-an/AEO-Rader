'use strict';
/**
 * AEO Radar — zero-dependency HTTP server (node:http) + REST API.
 * Scan endpoint streams progress as NDJSON so the UI can show live status.
 *
 * Routes:
 *   GET  /api/config            → current brand config (apiKeys redacted)
 *   PUT  /api/config            → update config (accepts apiKeys)
 *   POST /api/scan              → run a scan; NDJSON stream of progress+final run
 *   GET  /api/runs              → run summaries (no full analyses)
 *   GET  /api/runs/:id          → full run
 *   GET  /api/export/csv        → latest run as CSV
 *   POST /api/reset             → wipe data, restore demo defaults
 *   GET  /api/health            → { ok }
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const { runScan } = require('./lib/engine');
const { buildQuestionBank } = require('./lib/questions');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function redactConfig(config) {
  const { apiKeys, ...rest } = config;
  return {
    ...rest,
    hasKeys: {
      groq: Boolean((apiKeys && apiKeys.groq) || process.env.GROQ_API_KEY),
      openai: Boolean((apiKeys && apiKeys.openai) || process.env.OPENAI_API_KEY),
      anthropic: Boolean((apiKeys && apiKeys.anthropic) || process.env.ANTHROPIC_API_KEY),
    },
  };
}

const PROVIDER_ENV = { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

function resolveProvider(provider, config) {
  if (provider && provider !== 'demo') {
    const key = (config.apiKeys && config.apiKeys[provider]) || process.env[PROVIDER_ENV[provider]];
    if (!key) return 'demo'; // silently fall back so the product always works
    return provider;
  }
  return 'demo';
}

function summarizeRun(run) {
  return {
    id: run.id,
    ts: run.ts,
    provider: run.provider,
    model: run.model,
    scores: run.scores,
    durationMs: run.durationMs,
    questionCount: run.analyses.length,
  };
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function runToCsv(run) {
  const header = 'run_id,timestamp,provider,question_id,intent,question,position,sentiment,mentioned_brands,sources,self_cited';
  const rows = run.analyses.map((a) =>
    [
      run.id, run.ts, run.provider, a.questionId, a.intent, a.question,
      a.position, a.sentiment, a.mentionedBrands.join(' | '), a.sources.join(' | '),
      a.selfCited ? 'yes' : 'no',
    ].map(csvEscape).join(',')
  );
  return [header, ...rows].join('\n');
}

async function handleApi(req, res, pathname) {
  const config = db.getConfig();

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, name: 'aeo-radar', time: new Date().toISOString() });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, redactConfig(config));
  }

  if (req.method === 'PUT' && pathname === '/api/config') {
    const body = await readBody(req);
    const patch = {};
    for (const k of ['brand', 'domain', 'category', 'audience']) {
      if (typeof body[k] === 'string') patch[k] = body[k].trim();
    }
    if (Array.isArray(body.competitors)) {
      patch.competitors = body.competitors
        .filter((c) => c && typeof c.name === 'string' && c.name.trim())
        .slice(0, 4)
        .map((c) => ({ name: c.name.trim(), domain: (c.domain || '').trim() }));
    }
    if (body.provider && ['demo', 'groq', 'openai', 'anthropic'].includes(body.provider)) {
      patch.provider = body.provider;
    }
    if (body.apiKeys && typeof body.apiKeys === 'object') {
      const cur = config.apiKeys || {};
      patch.apiKeys = {
        groq: typeof body.apiKeys.groq === 'string' ? body.apiKeys.groq.trim() : cur.groq,
        openai: typeof body.apiKeys.openai === 'string' ? body.apiKeys.openai.trim() : cur.openai,
        anthropic: typeof body.apiKeys.anthropic === 'string' ? body.apiKeys.anthropic.trim() : cur.anthropic,
      };
    }
    const next = db.setConfig(patch);
    return sendJson(res, 200, redactConfig(next));
  }

  if (req.method === 'POST' && pathname === '/api/scan') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* empty body ok */ }
    const provider = resolveProvider(body.provider || config.provider, config);
    const cfg = db.getConfig();

    // NDJSON progress stream
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    const write = (obj) => res.write(JSON.stringify(obj) + '\n');
    write({ type: 'start', provider, questionCount: buildQuestionBank(cfg).length });

    try {
      const run = await runScan(cfg, provider, (e) => write(e));
      db.addRun(run);
      write({ type: 'done', run });
    } catch (err) {
      write({ type: 'error', error: String(err.message || err) });
    }
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/api/runs') {
    return sendJson(res, 200, { runs: db.getRuns().map(summarizeRun) });
  }

  let m = /^\/api\/runs\/([\w-]+)$/.exec(pathname);
  if (req.method === 'GET' && m) {
    const run = db.getRun(m[1]);
    return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: 'run not found' });
  }

  if (req.method === 'GET' && pathname === '/api/export/csv') {
    const run = db.latestRun();
    if (!run) return sendJson(res, 404, { error: 'no runs yet' });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="aeo-radar-${run.id}.csv"`,
    });
    return res.end(runToCsv(run));
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    db.resetAll();
    await seedIfNeeded();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/** First boot (demo mode): seed a config + an initial scan so the dashboard is alive. */
async function seedIfNeeded() {
  if (!db.latestRun()) {
    const cfg = db.getConfig();
    const run = await runScan(cfg, 'demo', () => {});
    db.addRun(run);
    console.log(`[seed] initial demo scan complete — visibility ${run.scores.visibility}/100 (${run.scores.grade})`);
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  }
});

seedIfNeeded()
  .catch((e) => console.error('[seed] failed:', e))
  .finally(() => {
    server.listen(PORT, () => {
      console.log('');
      console.log('  AEO RADAR — AI Search Visibility Tracker');
      console.log(`  Dashboard  →  http://localhost:${PORT}`);
      console.log(`  MCP server →  node mcp-server.js   (stdio JSON-RPC)`);
      console.log('');
    });
  });
