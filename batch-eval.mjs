#!/usr/bin/env node
/**
 * batch-eval.mjs — Batch Gemini Job Evaluator for career-ops
 *
 * Reads all pending "- [ ]" entries from data/pipeline.md,
 * fetches each job description from the URL, evaluates it using
 * the Gemini API (A-G scoring), saves a report to reports/, and
 * prints a ranked compatibility table at the end.
 *
 * Usage:
 *   node batch-eval.mjs                    # evaluate all pending jobs
 *   node batch-eval.mjs --limit 10         # evaluate first 10 only
 *   node batch-eval.mjs --company Mistral  # filter by company name
 *   node batch-eval.mjs --dry-run          # show job list, no API calls
 *   node batch-eval.mjs --resume           # skip already-evaluated jobs (default: on)
 *   node batch-eval.mjs --no-resume        # re-evaluate everything
 *   node batch-eval.mjs --delay 5000       # ms between API calls (default: 8000)
 *
 * Requires: GEMINI_API_KEY in .env
 * Free tier: 15 RPM — default delay keeps you under the limit.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Bootstrap .env ──────────────────────────────────────────────────────────
try {
  const { config } = await import('dotenv');
  config();
} catch { /* dotenv optional */ }

import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Paths ───────────────────────────────────────────────────────────────────
const ROOT        = dirname(fileURLToPath(import.meta.url));
const PIPELINE    = join(ROOT, 'data', 'pipeline.md');
const REPORTS_DIR = join(ROOT, 'reports');
const SHARED_MD   = join(ROOT, 'modes', '_shared.md');
const OFERTA_MD   = join(ROOT, 'modes', 'oferta.md');
const CV_MD       = join(ROOT, 'cv.md');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun       = args.includes('--dry-run');
const noResume     = args.includes('--no-resume');
const resume       = !noResume; // default: skip already-evaluated

const limitIdx     = args.indexOf('--limit');
const limit        = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : Infinity;

const companyIdx   = args.indexOf('--company');
const filterCompany = companyIdx !== -1 ? args[companyIdx + 1]?.toLowerCase() : null;

const delayIdx     = args.indexOf('--delay');
// gemini-2.5-flash free tier = 5 RPM → need at least 12s between calls.
// Using 13s for safety. Override with --delay if you're on a paid tier.
const DELAY_MS     = delayIdx !== -1 ? parseInt(args[delayIdx + 1]) : 13000;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║        career-ops — Batch Gemini Evaluator (free-tier)          ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluates all pending jobs from data/pipeline.md using Gemini.

  USAGE
    node batch-eval.mjs                    # evaluate all pending
    node batch-eval.mjs --limit 10         # first 10 only
    node batch-eval.mjs --company Mistral  # filter by company
    node batch-eval.mjs --dry-run          # preview list, no API
    node batch-eval.mjs --no-resume        # re-evaluate all
    node batch-eval.mjs --delay 5000       # ms between calls

  OUTPUT
    reports/<num>-<company>-<date>.md      # full A-G evaluation
    (final ranked table printed to console)
`);
  process.exit(0);
}

// ── Validate env ─────────────────────────────────────────────────────────────
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey && !dryRun) {
  console.error(`
❌  GEMINI_API_KEY not found.
   Add it to .env:  GEMINI_API_KEY=your_key_here
`);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function readFile(path, label) {
  if (!existsSync(path)) return `[${label} not found]`;
  return readFileSync(path, 'utf-8').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Strip HTML tags and collapse whitespace to extract readable text */
function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Fetch a URL and return plain text (best-effort) */
async function fetchJobText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; career-ops-scanner/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = htmlToText(html);
    // Return first 8000 chars — enough for most JDs
    return text.slice(0, 8000);
  } catch (err) {
    throw new Error(`Fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Determine next report number based on existing files */
function nextReportNumber() {
  if (!existsSync(REPORTS_DIR)) return '001';
  const nums = readdirSync(REPORTS_DIR)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)))
    .filter(n => !isNaN(n));
  if (nums.length === 0) return '001';
  return String(Math.max(...nums) + 1).padStart(3, '0');
}

/** Check if a company+role combo already has a report */
function alreadyEvaluated(company, role) {
  if (!existsSync(REPORTS_DIR)) return false;
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const roleSlug = role.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  return readdirSync(REPORTS_DIR).some(f =>
    f.includes(slug) || f.includes(roleSlug)
  );
}

// ── Parse pipeline.md ─────────────────────────────────────────────────────────
if (!existsSync(PIPELINE)) {
  console.error('❌  data/pipeline.md not found. Run: node scan.mjs first.');
  process.exit(1);
}

const pipelineText = readFileSync(PIPELINE, 'utf-8');
const pendingRegex = /^- \[ \] (https?:\/\/\S+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/gm;

const allJobs = [];
for (const match of pipelineText.matchAll(pendingRegex)) {
  allJobs.push({
    url:     match[1].trim(),
    company: match[2].trim(),
    role:    match[3].trim(),
  });
}

if (allJobs.length === 0) {
  console.log('✅  No pending jobs in data/pipeline.md — nothing to evaluate.');
  process.exit(0);
}

// Apply company filter
let jobs = filterCompany
  ? allJobs.filter(j => j.company.toLowerCase().includes(filterCompany))
  : allJobs;

// Apply resume: skip already-evaluated
if (resume) {
  const before = jobs.length;
  jobs = jobs.filter(j => !alreadyEvaluated(j.company, j.role));
  const skipped = before - jobs.length;
  if (skipped > 0) console.log(`⏩  Skipping ${skipped} already-evaluated jobs (use --no-resume to re-run)`);
}

// Apply limit
if (jobs.length > limit) {
  console.log(`🔢  Limiting to first ${limit} of ${jobs.length} jobs`);
  jobs = jobs.slice(0, limit);
}

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  career-ops Batch Evaluator — ${jobs.length} jobs to process`);
console.log(`╚══════════════════════════════════════════════════════════╝\n`);

if (dryRun) {
  console.log('📋  DRY RUN — jobs that would be evaluated:\n');
  jobs.forEach((j, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. [${j.company}] ${j.role}`);
    console.log(`       ${j.url}`);
  });
  console.log(`\n  Total: ${jobs.length} jobs`);
  console.log(`  Estimated time: ~${Math.ceil((jobs.length * DELAY_MS) / 60000)} minutes`);
  console.log('\n  Remove --dry-run to start evaluation.');
  process.exit(0);
}

// ── Load evaluation context ───────────────────────────────────────────────────
console.log('📂  Loading evaluation context...');
const sharedContext = readFile(SHARED_MD, 'modes/_shared.md');
const ofertaLogic   = readFile(OFERTA_MD, 'modes/oferta.md');
const cvContent     = readFile(CV_MD,     'cv.md');

// ── Setup Gemini ─────────────────────────────────────────────────────────────
// IMPORTANT: gemini-2.0-flash has 15 RPM + 1500 RPD on free tier.
// gemini-2.5-flash free tier is only 5 RPM + 20 RPD — avoid for batch use.
const modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const genAI     = new GoogleGenerativeAI(apiKey);
const model     = genAI.getGenerativeModel({
  model: modelName,
  generationConfig: {
    temperature:      0.3,
    maxOutputTokens:  6144,
  },
});

const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.
You are running in BATCH mode — you do NOT have access to Playwright or real-time web search.
Provide salary estimates from training data (clearly marked as estimates).

Your evaluation methodology:

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
BATCH MODE RULES
═══════════════════════════════════════════════════════
1. No Playwright/WebSearch available. Use training data for comp estimates.
2. Generate Blocks A through G in full, in English.
3. Be concise — aim for ~800-1200 words total. Focus on actionable insights.
4. At the very end, output this machine-readable block EXACTLY:

---SCORE_SUMMARY---
COMPANY: <company name>
ROLE: <role title>
SCORE: <decimal score, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
RECOMMENDATION: <APPLY | SKIP | MAYBE>
---END_SUMMARY---`;

// ── Evaluate function ─────────────────────────────────────────────────────────
async function evaluateJob(job, index, total) {
  const prefix = `[${String(index + 1).padStart(3)}/${total}]`;
  console.log(`\n${prefix} 🔍  ${job.company} — ${job.role}`);
  console.log(`         ${job.url}`);

  // 1. Fetch JD
  let jdText = '';
  try {
    process.stdout.write('         Fetching JD... ');
    jdText = await fetchJobText(job.url);
    console.log(`✓ (${jdText.length} chars)`);
  } catch (err) {
    console.log(`✗ ${err.message}`);
    jdText = `[Could not fetch JD from ${job.url} — ${err.message}]
Company: ${job.company}
Role: ${job.role}
URL: ${job.url}
Please evaluate based on the role title and company context only.`;
  }

  // 2. Call Gemini (with exponential backoff retry)
  let evalText = '';
  const maxRetries = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      process.stdout.write(attempt === 1 ? '         Calling Gemini... ' : `         Retry ${attempt}/${maxRetries}... `);
      const result = await model.generateContent([
        { text: systemPrompt },
        { text: `\n\nJOB TO EVALUATE:\nCompany: ${job.company}\nRole: ${job.role}\nURL: ${job.url}\n\nJOB DESCRIPTION TEXT:\n${jdText}` },
      ]);
      evalText = result.response.text();
      console.log('✓');
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const isRateLimit = err.message?.includes('quota') || err.message?.includes('rate') || err.message?.includes('429');
      if (isRateLimit && attempt < maxRetries) {
        const waitSec = 30 * attempt; // 30s, 60s
        console.log(`✗ rate limit — waiting ${waitSec}s (attempt ${attempt}/${maxRetries})...`);
        await sleep(waitSec * 1000);
      } else {
        console.log(`✗ ${err.message}`);
        break;
      }
    }
  }
  if (lastErr) {
    return { ...job, error: lastErr.message, score: null, recommendation: 'ERROR' };
  }

  // 3. Parse score summary
  const match = evalText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  const extract = (key) => {
    if (!match) return 'unknown';
    const m = match[1].match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : 'unknown';
  };

  const company        = extract('COMPANY');
  const role           = extract('ROLE');
  const scoreStr       = extract('SCORE');
  const archetype      = extract('ARCHETYPE');
  const legitimacy     = extract('LEGITIMACY');
  const recommendation = extract('RECOMMENDATION');
  const score          = parseFloat(scoreStr) || null;

  // 4. Save report
  const num       = nextReportNumber();
  const today     = new Date().toISOString().split('T')[0];
  const slug      = (company === 'unknown' ? job.company : company)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename  = `${num}-${slug}-${today}.md`;
  const reportPath = join(REPORTS_DIR, filename);

  mkdirSync(REPORTS_DIR, { recursive: true });

  const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**URL:** ${job.url}
**Archetype:** ${archetype}
**Score:** ${scoreStr}/5
**Legitimacy:** ${legitimacy}
**Recommendation:** ${recommendation}
**Tool:** Gemini (${modelName}) — batch-eval.mjs

---

${evalText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

  writeFileSync(reportPath, reportContent, 'utf-8');
  console.log(`         📄  Saved: reports/${filename}  |  Score: ${scoreStr}/5  |  ${recommendation}`);

  return { ...job, score, scoreStr, archetype, legitimacy, recommendation, reportFile: filename, error: null };
}

// ── Main batch loop ───────────────────────────────────────────────────────────
const results = [];
const startTime = Date.now();

console.log(`⏱️   Estimated time: ~${Math.ceil((jobs.length * DELAY_MS) / 60000)} minutes`);
console.log(`🤖  Model: ${modelName} | Delay: ${DELAY_MS}ms between calls\n`);
console.log('─'.repeat(60));

for (let i = 0; i < jobs.length; i++) {
  const result = await evaluateJob(jobs[i], i, jobs.length);
  results.push(result);

  // Rate limit delay (except after last job)
  if (i < jobs.length - 1) {
    await sleep(DELAY_MS);
  }
}

// ── Final ranked table ────────────────────────────────────────────────────────
const elapsed = Math.round((Date.now() - startTime) / 1000);

console.log('\n\n' + '═'.repeat(70));
console.log('  BATCH EVALUATION COMPLETE — RANKED COMPATIBILITY TABLE');
console.log('═'.repeat(70));
console.log(`  Evaluated: ${results.length} jobs in ${elapsed}s\n`);

// Separate successful and errored
const successful = results.filter(r => r.score !== null).sort((a, b) => b.score - a.score);
const errored    = results.filter(r => r.score === null);

// Print ranked table
if (successful.length > 0) {
  const recEmoji = (r) => {
    if (r.recommendation === 'APPLY') return '🟢';
    if (r.recommendation === 'MAYBE') return '🟡';
    if (r.recommendation === 'SKIP')  return '🔴';
    return '⚪';
  };

  console.log('  Rank | Score | Rec  | Company              | Role');
  console.log('  ' + '─'.repeat(66));
  successful.forEach((r, i) => {
    const rank    = String(i + 1).padStart(4);
    const score   = (r.scoreStr || '?/5').padEnd(5);
    const rec     = recEmoji(r);
    const company = r.company.slice(0, 20).padEnd(20);
    const role    = r.role.slice(0, 35);
    console.log(`  ${rank} | ${score} | ${rec}   | ${company} | ${role}`);
  });
}

// Apply recommendations summary
const applyList = successful.filter(r => r.recommendation === 'APPLY');
const maybeList = successful.filter(r => r.recommendation === 'MAYBE');

if (applyList.length > 0) {
  console.log('\n  🟢  APPLY — Top picks:');
  applyList.forEach(r => console.log(`      • [${r.scoreStr}/5] ${r.company} — ${r.role}  →  reports/${r.reportFile}`));
}

if (maybeList.length > 0) {
  console.log('\n  🟡  MAYBE — Worth a closer look:');
  maybeList.slice(0, 5).forEach(r => console.log(`      • [${r.scoreStr}/5] ${r.company} — ${r.role}`));
}

if (errored.length > 0) {
  console.log(`\n  ❌  Errors (${errored.length} jobs failed):`);
  errored.forEach(r => console.log(`      • ${r.company} — ${r.role}: ${r.error}`));
}

// Save results JSON summary
const summaryPath = join(ROOT, 'data', `batch-eval-${new Date().toISOString().split('T')[0]}.json`);
writeFileSync(summaryPath, JSON.stringify({
  date:      new Date().toISOString(),
  model:     modelName,
  total:     results.length,
  evaluated: successful.length,
  errors:    errored.length,
  results:   results.map(r => ({
    company:        r.company,
    role:           r.role,
    url:            r.url,
    score:          r.score,
    scoreStr:       r.scoreStr,
    archetype:      r.archetype,
    legitimacy:     r.legitimacy,
    recommendation: r.recommendation,
    reportFile:     r.reportFile,
    error:          r.error,
  })),
}, null, 2), 'utf-8');

console.log(`\n  📊  Full results saved: data/batch-eval-${new Date().toISOString().split('T')[0]}.json`);
console.log(`  📁  Reports saved in:   reports/`);
console.log('\n  → Review top picks with: node gemini-eval.mjs --file <jd-file>');
console.log('═'.repeat(70) + '\n');
