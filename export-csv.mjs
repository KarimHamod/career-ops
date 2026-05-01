#!/usr/bin/env node
/**
 * export-csv.mjs — Export all scanned jobs to a clean CSV
 *
 * Merges data from:
 *   - data/scan-history.tsv     (source of truth for all scanned jobs)
 *   - data/pipeline.md          (pending / checked-off status)
 *   - data/batch-eval-*.json    (Gemini scores & recommendations, if run)
 *
 * Output: data/jobs-export-YYYY-MM-DD.csv
 *
 * Usage:
 *   node export-csv.mjs                     # export all jobs
 *   node export-csv.mjs --evaluated-only    # only jobs with a Gemini score
 *   node export-csv.mjs --out my-jobs.csv   # custom output path
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const evaluatedOnly = args.includes('--evaluated-only');
const outIdx = args.indexOf('--out');
const today = new Date().toISOString().split('T')[0];
const outputPath = outIdx !== -1
  ? args[outIdx + 1]
  : join(ROOT, 'data', `jobs-export-${today}.csv`);

// ── Load scan-history.tsv ─────────────────────────────────────────────────────
const tsvPath = join(ROOT, 'data', 'scan-history.tsv');
if (!existsSync(tsvPath)) {
  console.error('❌  data/scan-history.tsv not found. Run: node scan.mjs first.');
  process.exit(1);
}

const tsvLines = readFileSync(tsvPath, 'utf-8').split('\n').filter(Boolean);
const tsvHeader = tsvLines[0].split('\t'); // url, first_seen, portal, title, company, status

// Build map: url → { first_seen, portal, title, company }
const historyMap = new Map();
for (const line of tsvLines.slice(1)) {
  const cols = line.split('\t');
  if (cols.length < 5) continue;
  const [url, first_seen, portal, title, company] = cols;
  historyMap.set(url.trim(), {
    url:        url.trim(),
    first_seen: first_seen?.trim() || '',
    portal:     portal?.trim() || '',
    title:      title?.trim() || '',
    company:    company?.trim() || '',
  });
}

// ── Load pipeline.md — determine pipeline status per URL ──────────────────────
const pipelinePath = join(ROOT, 'data', 'pipeline.md');
const pipelineStatus = new Map(); // url → 'Pending' | 'Done'

if (existsSync(pipelinePath)) {
  const text = readFileSync(pipelinePath, 'utf-8');
  for (const match of text.matchAll(/^- \[( |x)\] (https?:\/\/\S+)/gm)) {
    const checked = match[1] === 'x';
    const url = match[2].trim();
    pipelineStatus.set(url, checked ? 'Done' : 'Pending');
  }
}

// ── Load latest batch-eval JSON (scores + recommendations) ───────────────────
const dataDir = join(ROOT, 'data');
const evalJsonFiles = existsSync(dataDir)
  ? readdirSync(dataDir)
      .filter(f => f.startsWith('batch-eval-') && f.endsWith('.json'))
      .sort()  // alphabetical = chronological for YYYY-MM-DD filenames
  : [];

// Merge all eval results, later files overwrite earlier (most recent wins)
const evalMap = new Map(); // url → { score, scoreStr, archetype, legitimacy, recommendation, reportFile }
for (const file of evalJsonFiles) {
  try {
    const data = JSON.parse(readFileSync(join(dataDir, file), 'utf-8'));
    for (const r of data.results || []) {
      if (r.url) evalMap.set(r.url, r);
    }
  } catch { /* skip malformed JSON */ }
}

// ── Build unified job list ────────────────────────────────────────────────────
let jobs = [];
let idx = 1;

for (const [url, hist] of historyMap) {
  const eval_ = evalMap.get(url) || {};
  const pipeline = pipelineStatus.get(url) || 'Pending';

  // Determine portal display name
  const portalDisplay = {
    'ashby-api':      'Ashby',
    'greenhouse-api': 'Greenhouse',
    'lever-api':      'Lever',
  }[hist.portal] || hist.portal || '';

  jobs.push({
    '#':             idx++,
    'Date Found':    hist.first_seen,
    'Company':       hist.company || eval_.company || '',
    'Role':          hist.title   || eval_.role    || '',
    'Portal':        portalDisplay,
    'Pipeline':      pipeline,
    'Score':         eval_.scoreStr  || '',
    'Recommendation':eval_.recommendation || '',
    'Archetype':     eval_.archetype || '',
    'Legitimacy':    eval_.legitimacy || '',
    'Report':        eval_.reportFile ? `reports/${eval_.reportFile}` : '',
    'URL':           url,
  });
}

// Apply --evaluated-only filter
if (evaluatedOnly) {
  jobs = jobs.filter(j => j['Score'] !== '');
  console.log(`🔍  Filtered to ${jobs.length} evaluated jobs`);
}

// Sort: evaluated first (by score desc), then pending alphabetically by company
jobs.sort((a, b) => {
  const sa = parseFloat(a['Score']) || 0;
  const sb = parseFloat(b['Score']) || 0;
  if (sa !== sb) return sb - sa; // score desc
  return a['Company'].localeCompare(b['Company']);
});

// Re-number after sort
jobs.forEach((j, i) => { j['#'] = i + 1; });

// ── CSV serialisation ─────────────────────────────────────────────────────────
const COLUMNS = [
  '#', 'Date Found', 'Company', 'Role', 'Portal', 'Pipeline',
  'Score', 'Recommendation', 'Archetype', 'Legitimacy', 'Report', 'URL',
];

function csvCell(value) {
  const str = String(value ?? '');
  // Quote if contains comma, double-quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const csvLines = [
  COLUMNS.join(','),
  ...jobs.map(j => COLUMNS.map(col => csvCell(j[col])).join(',')),
];

const csvContent = csvLines.join('\r\n'); // CRLF for Excel on Windows
writeFileSync(outputPath, '\uFEFF' + csvContent, 'utf-8'); // BOM for Excel UTF-8

// ── Summary ───────────────────────────────────────────────────────────────────
const evaluated  = jobs.filter(j => j['Score'] !== '').length;
const withApply  = jobs.filter(j => j['Recommendation'] === 'APPLY').length;
const withMaybe  = jobs.filter(j => j['Recommendation'] === 'MAYBE').length;

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║           career-ops — CSV Export Complete              ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');
console.log(`  📄  Output:       ${outputPath}`);
console.log(`  📊  Total jobs:   ${jobs.length}`);
console.log(`  🤖  Evaluated:    ${evaluated} (Gemini scored)`);
console.log(`  🟢  APPLY:        ${withApply}`);
console.log(`  🟡  MAYBE:        ${withMaybe}`);
console.log(`  ⏳  Pending eval: ${jobs.length - evaluated}\n`);
console.log('  → Open in Excel, Google Sheets, or any CSV viewer.');
console.log('  → Columns: #, Date Found, Company, Role, Portal, Pipeline,');
console.log('             Score, Recommendation, Archetype, Legitimacy, Report, URL\n');
