'use strict';
/**
 * AEO Radar — MCP (Model Context Protocol) stdio server.
 *
 * Lets any MCP client (Claude Desktop, agents, IDE copilots) query brand
 * visibility data directly:
 *
 *   tools:
 *     aeo_get_report     → latest visibility report summary
 *     aeo_run_scan       → run a fresh scan (provider optional)
 *     aeo_get_history    → score over time
 *     aeo_get_questions  → the current buyer-intent question bank
 *     aeo_get_config     → tracked brand + competitors
 *
 * Wire it up (e.g. claude_desktop_config.json):
 *   { "mcpServers": { "aeo-radar": { "command": "node",
 *       "args": ["<path>/aeo-radar/mcp-server.js"] } } }
 *
 * Handshake test:
 *   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp-server.js
 */
const db = require('./lib/db');
const { runScan } = require('./lib/engine');
const { buildQuestionBank } = require('./lib/questions');

const TOOLS = [
  {
    name: 'aeo_get_report',
    description:
      'Get the latest AI search visibility report for the tracked brand: visibility score, grade, mention rate, average answer position, sentiment, share of voice vs competitors, and prioritized recommendations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aeo_run_scan',
    description:
      'Run a fresh AI visibility scan (buyer-intent questions answered by an AI provider, then scored). Returns the full run. Default provider is the built-in demo simulation; use "openai" or "anthropic" if API keys are configured.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['demo', 'groq', 'openai', 'anthropic'], description: 'Optional. Defaults to configured provider.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'aeo_get_history',
    description: 'Visibility score over time (most recent runs first) for trend analysis.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aeo_get_questions',
    description: 'The buyer-intent question bank used to probe AI answers for the tracked brand.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aeo_get_config',
    description: 'Currently tracked brand, domain, category, audience and competitors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function toolReport() {
  const run = db.latestRun();
  if (!run) return { status: 'no scans yet — call aeo_run_scan first' };
  const s = run.scores;
  return {
    runId: run.id,
    timestamp: run.ts,
    provider: run.provider,
    brand: run.config.brand,
    visibilityScore: s.visibility,
    grade: s.grade,
    mentionRatePct: s.mentionRate,
    avgPosition: s.avgPosition,
    sentiment: s.sentiment,
    citedSourcesCount: s.citedCount,
    shareOfVoicePct: s.shareOfVoice,
    byIntent: s.byIntent,
    recommendations: run.recommendations,
  };
}

function toolHistory() {
  return db.getRuns().map((r) => ({
    runId: r.id,
    timestamp: r.ts,
    provider: r.provider,
    visibilityScore: r.scores.visibility,
    grade: r.scores.grade,
    mentionRatePct: r.scores.mentionRate,
    avgPosition: r.scores.avgPosition,
  }));
}

function toolQuestions() {
  return buildQuestionBank(db.getConfig());
}

function toolConfig() {
  const c = db.getConfig();
  return {
    brand: c.brand,
    domain: c.domain,
    category: c.category,
    audience: c.audience,
    competitors: c.competitors,
    provider: c.provider,
  };
}

async function callTool(name, args) {
  switch (name) {
    case 'aeo_get_report':
      return toolReport();
    case 'aeo_get_history':
      return toolHistory();
    case 'aeo_get_questions':
      return toolQuestions();
    case 'aeo_get_config':
      return toolConfig();
    case 'aeo_run_scan': {
      const config = db.getConfig();
      let provider = (args && args.provider) || config.provider || 'demo';
      if (provider !== 'demo') {
        const envKey = { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[provider];
        const key = (config.apiKeys && config.apiKeys[provider]) || (envKey && process.env[envKey]);
        if (!key) provider = 'demo';
      }
      const run = await runScan(config, provider, () => {});
      db.addRun(run);
      return toolReport();
    }
    default:
      throw new Error('unknown tool: ' + name);
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on('end', () => process.exit(0));

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return; // ignore non-JSON noise on stdin
  }
  const { id, method, params } = msg;

  // Notifications (no id) get no response.
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aeo-radar', version: '1.0.0' },
      });
    }
    if (method === 'tools/list') {
      return reply(id, { tools: TOOLS });
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const data = await callTool(name, args);
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        });
      } catch (err) {
        return reply(id, {
          content: [{ type: 'text', text: 'error: ' + String(err.message || err) }],
          isError: true,
        });
      }
    }
    if (method === 'resources/list') return reply(id, { resources: [] });
    if (method === 'prompts/list') return reply(id, { prompts: [] });
    if (method === 'ping') return reply(id, {});
    return replyError(id, -32601, 'method not found: ' + method);
  } catch (err) {
    replyError(id, -32603, String(err.message || err));
  }
}

console.error('[aeo-radar MCP] stdio server ready — tools: ' + TOOLS.map((t) => t.name).join(', '));
