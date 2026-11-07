'use strict';
/**
 * Zero-dependency JSON file store with debounced atomic writes.
 * Layout: { config, runs: [ ... newest first ] }
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const MAX_RUNS = 60;

const DEFAULT_CONFIG = {
  brand: 'Nimbus CRM',
  domain: 'nimbuscrm.io',
  category: 'CRM software',
  audience: 'small businesses',
  competitors: [
    { name: 'HubSpot', domain: 'hubspot.com' },
    { name: 'Salesforce', domain: 'salesforce.com' },
    { name: 'Pipedrive', domain: 'pipedrive.com' },
  ],
  provider: 'demo', // demo | groq | openai | anthropic
  apiKeys: { groq: '', openai: '', anthropic: '' }, // stored locally in data/db.json only
};

let state = null;
let writeTimer = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (state) return state;
  ensureDir();
  try {
    if (fs.existsSync(DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      state = {
        config: Object.assign({}, DEFAULT_CONFIG, parsed.config || {}),
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      };
      return state;
    }
  } catch (err) {
    console.error('[db] failed to read db.json, starting fresh:', err.message);
  }
  state = { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), runs: [] };
  persistNow();
  return state;
}

function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!state) return;
  ensureDir();
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function persist() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      flush();
    } catch (err) {
      console.error('[db] write failed:', err.message);
    }
  }, 150);
}

function getConfig() {
  return load().config;
}

function setConfig(patch) {
  const s = load();
  s.config = Object.assign({}, s.config, patch);
  // never let config wipes break the shape
  if (!Array.isArray(s.config.competitors)) s.config.competitors = [];
  persist();
  return s.config;
}

function getRuns() {
  return load().runs;
}

function getRun(id) {
  return load().runs.find((r) => r.id === id) || null;
}

function latestRun() {
  const runs = load().runs;
  return runs.length ? runs[0] : null;
}

function addRun(run) {
  const s = load();
  s.runs.unshift(run);
  if (s.runs.length > MAX_RUNS) s.runs.length = MAX_RUNS;
  persist();
  return run;
}

/** Wipe runs + reset config (used by "Reset demo data"). */
function resetAll() {
  const s = load();
  s.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  s.runs = [];
  persistNow();
  return s;
}

function persistNow() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  flush();
}

module.exports = {
  getConfig,
  setConfig,
  getRuns,
  getRun,
  latestRun,
  addRun,
  resetAll,
  persistNow,
  DB_PATH,
  DEFAULT_CONFIG,
};
