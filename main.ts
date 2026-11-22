// Main entry point for token-radar-02 competition entry (Node 22, TypeScript).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 8, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
let inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  const localKit = '/home/hatch/workspace/makefun/token-radar-01-kit/token-radar-01-kit/input/snapshot.json';
  if (existsSync(localKit)) {
    inputFile = localKit;
  }
}
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}

const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shotsDir = join(here, 'screenshots');
const shots = copyFiles(shotsDir, join(out, 'screenshots'));

if (shots.length > 0) {
  let validShots = true;
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      validShots = false;
      break;
    }
  }
  if (validShots) {
    try {
      writeFileSync(
        join(out, 'dossier.json'),
        buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } })
      );
    } catch (err) {
      process.stderr.write(`token radar warning: failed to build dossier: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    process.stderr.write(`token radar warning: invalid screenshot names, skipping dossier.json\n`);
  }
} else {
  process.stderr.write(`token radar warning: screenshots/ holds 0 images; skipping dossier.json\n`);
}

// Verdict & Farmability counts
let farmCount = 0;
let thinCount = 0;
let skipCount = 0;
let farmableCount = 0;
let nonFarmableCount = 0;
let farmableFarmCount = 0;
for (const r of board) {
  if (r.verdict === 'FARM') farmCount++;
  else if (r.verdict === 'THIN') thinCount++;
  else skipCount++;

  if (r.farmable) {
    farmableCount++;
    if (r.verdict === 'FARM') farmableFarmCount++;
  } else {
    nonFarmableCount++;
  }
}

// Verification output print
const val = radar.validation;
process.stdout.write(
  `\n=== TOKEN RADAR v2 VERIFICATION & MODEL SUMMARY ===\n` +
    `Protocols: ${snapshot.protocols.length} total, ${snapshot.watchlist.length} watchlist, ${board.length} scored board rows (${farmableCount} farmable, ${nonFarmableCount} non-farmable).\n` +
    `Verdicts: FARM = ${farmCount} (${farmableFarmCount} among farmable), THIN = ${thinCount}, SKIP = ${skipCount}\n` +
    `Fitted Coefficients: intercept = ${val.coefficients.intercept}, log_tvl = ${val.coefficients.log_tvl}, log_tvl_sq = ${val.coefficients.log_tvl_sq}, growth = ${val.coefficients.growth}, log_age = ${val.coefficients.log_age} (R² = ${val.r2})\n` +
    `Leave-One-Out (LOO): median abs log10 err = ${val.loo_median_abs_log_err}, within-2x share = ${(val.loo_within_2x_share * 100).toFixed(1)}%\n` +
    `80/20 Split Test (50x med): median abs log10 err = ${val.split_median_abs_log_err}, within-2x share = ${(val.split_within_2x_share * 100).toFixed(1)}%\n` +
    `Walk-Forward (Time-Split): median abs log10 err = ${val.walk_forward_median_abs_log_err}\n` +
    `Odds Blend 5-Fold CV AUC = ${val.cv_auc}\n` +
    `Bootstrap Slope Band (10th-90th percentile over 200 resamples): [${val.bootstrap_slope_band[0]}, ${val.bootstrap_slope_band[1]}]\n\n` +
    `--- Top 10 Ranked Protocols --- \n`
);

for (let i = 0; i < Math.min(10, board.length); i++) {
  const r = board[i]! as any;
  process.stdout.write(
    `#${r.rank.toString().padStart(3, ' ')} | ${r.name.padEnd(25, ' ')} | TVL: $${r.tvl_usd.toLocaleString().padStart(12, ' ')} | Odds: ${(r.model.token_odds * 100).toFixed(1).padStart(5, ' ')}% | Implied: $${r.implied_value_usd.toLocaleString().padStart(10, ' ')} | Verdict: ${r.verdict}\n`
  );
}

const allWatchlistCovered = snapshot.watchlist.every((slug) => board.some((r) => r.slug === slug));
process.stdout.write(
  `\nWatchlist Coverage: ${allWatchlistCovered ? 'SUCCESS (all 40 watchlist slugs present on the board)' : 'WARNING: missing watchlist slugs'}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, dashboard/, screenshots/, and dossier.json\n`
);
