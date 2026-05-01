#!/usr/bin/env node
/**
 * scan-linkedin.mjs — LinkedIn Jobs Scanner using Playwright
 *
 * Reads `search_queries` from portals.yml (entries whose name contains
 * "LinkedIn"), scrapes matching jobs, deduplicates, and appends to
 * data/pipeline.md + data/scan-history.tsv (same format as scan.mjs).
 *
 * Usage:
 *   node scan-linkedin.mjs              # public mode (no login required)
 *   node scan-linkedin.mjs --login      # login for more results
 *   node scan-linkedin.mjs --dry-run    # preview without writing files
 *   node scan-linkedin.mjs --pages 5    # pages per query (default: 3 = ~75 jobs)
 *   node scan-linkedin.mjs --query "France Gen AI"  # filter query by name
 *
 * Optional .env vars for --login mode:
 *   LINKEDIN_EMAIL=your@email.com
 *   LINKEDIN_PASSWORD=yourpassword
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

try { const { config } = await import('dotenv'); config(); } catch { /* dotenv optional */ }

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT          = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH  = join(ROOT, 'portals.yml');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const HISTORY_PATH  = join(ROOT, 'data', 'scan-history.tsv');
const SESSION_PATH  = join(ROOT, 'data', '.linkedin-session.json');

mkdirSync(join(ROOT, 'data'), { recursive: true });

// ── CLI ───────────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const dryRun      = args.includes('--dry-run');
const loginMode   = args.includes('--login');
const pagesIdx    = args.indexOf('--pages');
const MAX_PAGES   = pagesIdx !== -1 ? parseInt(args[pagesIdx + 1]) : 3;
const queryIdx    = args.indexOf('--query');
const filterQuery = queryIdx !== -1 ? args[queryIdx + 1]?.toLowerCase() : null;

const EMAIL    = process.env.LINKEDIN_EMAIL;
const PASSWORD = process.env.LINKEDIN_PASSWORD;

if (args.includes('--help')) {
  console.log(`
Usage:
  node scan-linkedin.mjs              public mode (no login)
  node scan-linkedin.mjs --login      login for more results
  node scan-linkedin.mjs --dry-run    preview without writing
  node scan-linkedin.mjs --pages 5    pages per query (default 3)
  node scan-linkedin.mjs --query foo  filter by query name

.env (for --login):
  LINKEDIN_EMAIL=your@email.com
  LINKEDIN_PASSWORD=yourpassword
`);
  process.exit(0);
}

// ── Dedup (mirrors scan.mjs) ──────────────────────────────────────────────────
function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(HISTORY_PATH)) {
    for (const line of readFileSync(HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url.trim());
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf-8').matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(m[1].trim());
    }
  }
  return seen;
}

// ── Title filter (mirrors scan.mjs) ──────────────────────────────────────────
function buildTitleFilter(tf) {
  const pos = (tf?.positive || []).map(k => k.toLowerCase());
  const neg = (tf?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const t = title.toLowerCase();
    return (pos.length === 0 || pos.some(k => t.includes(k))) && !neg.some(k => t.includes(k));
  };
}

// ── Pipeline writers (mirrors scan.mjs) ───────────────────────────────────────
function appendToPipeline(offers) {
  if (!offers.length) return;
  let text = existsSync(PIPELINE_PATH)
    ? readFileSync(PIPELINE_PATH, 'utf-8')
    : '# Pipeline\n\n## Pendientes\n\n## Procesadas\n';
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  const block = '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n';
  if (idx === -1) {
    text += block;
  } else {
    const next = text.indexOf('\n## ', idx + marker.length);
    const at   = next === -1 ? text.length : next;
    text = text.slice(0, at) + block + text.slice(at);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToHistory(offers, date) {
  if (!existsSync(HISTORY_PATH))
    writeFileSync(HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  const lines = offers.map(o =>
    `${o.url}\t${date}\tlinkedin\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';
  appendFileSync(HISTORY_PATH, lines, 'utf-8');
}

// ── Build LinkedIn Jobs search URL ────────────────────────────────────────────
function buildSearchUrl(queryStr, page = 0) {
  // Strip the Google site: prefix used in portals.yml
  let q = queryStr.replace(/site:linkedin\.com\/jobs\s*/gi, '').trim();

  // Detect and remove location from the query string
  const locationPatterns = [
    [/\bFrance\b/i, 'France'], [/\bremote\b/i, 'Remote'],
    [/\bUnited Kingdom\b|\bUK\b/i, 'United Kingdom'], [/\bLondon\b/i, 'London'],
    [/\bParis\b/i, 'Paris'], [/\bGermany\b/i, 'Germany'],
    [/\bNetherlands\b/i, 'Netherlands'], [/\bSpain\b/i, 'Spain'],
  ];
  let location = '';
  for (const [pat, val] of locationPatterns) {
    if (pat.test(q)) { location = val; q = q.replace(pat, '').trim(); break; }
  }

  // Clean keywords: strip quotes + OR connectors
  const keywords = q.replace(/"/g, '').replace(/\s+OR\s+/gi, ' ').replace(/\s+/g, ' ').trim();

  const params = new URLSearchParams({
    keywords,
    ...(location && { location }),
    f_TPR: 'r2592000', // last 30 days
    start:  String(page * 25),
  });
  return `https://www.linkedin.com/jobs/search/?${params}`;
}

// ── Scrape job cards from current page ───────────────────────────────────────
async function extractJobs(page) {
  await page.waitForTimeout(2000 + Math.random() * 1000);

  // Scroll to trigger lazy-loaded cards
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(400);
  }

  // Dismiss sign-in modal if present
  try {
    await page.click('[aria-label="Dismiss"], .modal__dismiss, button.contextual-sign-in-modal__modal-dismiss-btn', { timeout: 2000 });
  } catch { /* no modal */ }

  return page.evaluate(() => {
    const jobs = [];
    // Selectors for both logged-in and public layouts
    const cards = [
      ...document.querySelectorAll('li.jobs-search-results__list-item'),
      ...document.querySelectorAll('li.base-card'),
      ...document.querySelectorAll('ul.jobs-search__results-list > li'),
    ];

    const seen = new Set();
    for (const card of cards) {
      const titleEl   = card.querySelector('.job-card-list__title, .base-search-card__title, h3');
      const companyEl = card.querySelector('.job-card-container__primary-description, .base-search-card__subtitle, h4');
      const locationEl= card.querySelector('.job-card-container__metadata-item, .job-search-card__location');
      const linkEl    = card.querySelector('a.job-card-list__title, a.base-card__full-link, a[href*="/jobs/view/"]');

      const title    = titleEl?.textContent?.trim();
      const company  = companyEl?.textContent?.trim() || 'Unknown';
      const location = locationEl?.textContent?.trim() || '';
      let   url      = linkEl?.href || '';

      if (!title || !url) continue;

      // Normalise URL: keep only the /jobs/view/ID part to avoid tracking params
      const match = url.match(/(https:\/\/[^/]*linkedin\.com\/jobs\/view\/[^/?]+)/);
      if (match) url = match[1];

      if (seen.has(url)) continue;
      seen.add(url);
      jobs.push({ title, company, location, url });
    }
    return jobs;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('❌  portals.yml not found.');
    process.exit(1);
  }
  const config      = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleFilter = buildTitleFilter(config.title_filter);

  // Filter to LinkedIn search queries only
  let queries = (config.search_queries || [])
    .filter(q => q.enabled !== false && q.name?.toLowerCase().includes('linkedin'));

  if (filterQuery) queries = queries.filter(q => q.name.toLowerCase().includes(filterQuery));

  if (!queries.length) {
    console.log('⚠️   No LinkedIn search queries found in portals.yml');
    console.log('    Add entries under search_queries: with names containing "LinkedIn".');
    process.exit(0);
  }

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  career-ops LinkedIn Scanner — ${queries.length} queries`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const seenUrls    = loadSeenUrls();
  const date        = new Date().toISOString().slice(0, 10);
  const newOffers   = [];
  let totalFound    = 0;
  let totalFiltered = 0;
  let totalDupes    = 0;

  // ── Launch Playwright ───────────────────────────────────────────────────────
  const hasSession  = existsSync(SESSION_PATH);
  const headless    = hasSession && !loginMode; // visible on first run / explicit login

  console.log(`🌐  Launching browser (${headless ? 'headless' : 'visible'})...`);
  if (!headless) console.log('   Browser window will open — complete any verification if prompted.\n');

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 800 },
    locale:    'en-US',
  });

  // Suppress webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Load saved cookies
  if (hasSession) {
    try {
      const { cookies } = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
      await context.addCookies(cookies);
      console.log('✓  Loaded saved session\n');
    } catch { /* session corrupt, ignore */ }
  }

  const page = await context.newPage();

  // ── Login flow ──────────────────────────────────────────────────────────────
  if (loginMode && EMAIL && PASSWORD) {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    if (!page.url().includes('/feed')) {
      console.log('🔐  Logging in to LinkedIn...');
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.fill('#username', EMAIL);
      await page.waitForTimeout(600 + Math.random() * 400);
      await page.fill('#password', PASSWORD);
      await page.waitForTimeout(600 + Math.random() * 400);
      await page.click('[data-litms-control-urn="login-submit"], button[type="submit"]');
      await page.waitForTimeout(5000);

      // Handle 2FA / CAPTCHA
      if (page.url().includes('checkpoint') || page.url().includes('challenge')) {
        console.log('\n⚠️   LinkedIn requires verification in the browser window.');
        console.log('   Complete it, then press Enter here to continue...');
        await new Promise(r => process.stdin.once('data', r));
      }

      if (page.url().includes('/feed') || page.url().includes('/mynetwork')) {
        console.log('✓  Login successful');
        const cookies = await context.cookies();
        writeFileSync(SESSION_PATH, JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2));
        console.log('   Session saved → future runs will reuse it\n');
      } else {
        console.log(`⚠️   Login may have failed (URL: ${page.url()}). Continuing in public mode.`);
      }
    } else {
      console.log('✓  Already logged in (session valid)\n');
      const cookies = await context.cookies();
      writeFileSync(SESSION_PATH, JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2));
    }
  } else if (loginMode) {
    console.log('⚠️   --login requires LINKEDIN_EMAIL and LINKEDIN_PASSWORD in .env');
  }

  // ── Scrape each query ───────────────────────────────────────────────────────
  for (const query of queries) {
    console.log(`\n🔍  ${query.name}`);

    for (let p = 0; p < MAX_PAGES; p++) {
      const url = buildSearchUrl(query.query, p);
      process.stdout.write(`     Page ${p + 1}/${MAX_PAGES}... `);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const jobs = await extractJobs(page);
        console.log(`${jobs.length} jobs found`);
        totalFound += jobs.length;

        for (const job of jobs) {
          if (!titleFilter(job.title)) { totalFiltered++; continue; }
          if (seenUrls.has(job.url))   { totalDupes++;    continue; }
          seenUrls.add(job.url);
          newOffers.push({ ...job, source: 'linkedin' });
        }

        // Stop early if we got fewer than 10 results (last page)
        if (jobs.length < 10) break;

        await page.waitForTimeout(2000 + Math.random() * 1000);
      } catch (err) {
        console.log(`✗ ${err.message}`);
        break;
      }
    }
  }

  await browser.close();

  // ── Write results ───────────────────────────────────────────────────────────
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToHistory(newOffers, date);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`LinkedIn Scan — ${date}`);
  console.log('━'.repeat(45));
  console.log(`Queries run:       ${queries.length}`);
  console.log(`Total jobs found:  ${totalFound}`);
  console.log(`Filtered by title: ${totalFiltered} removed`);
  console.log(`Duplicates:        ${totalDupes} skipped`);
  console.log(`New offers added:  ${newOffers.length}`);

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save)');
    } else {
      console.log(`\nSaved to ${PIPELINE_PATH}`);
      console.log('→ Run: node batch-eval.mjs to score new jobs with Gemini');
    }
  }

  console.log('\n' + '━'.repeat(45) + '\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
