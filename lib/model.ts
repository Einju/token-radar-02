// The token radar model v2: quadratic OLS size curve, fitted growth & age, shrunk category adjustments,
// blended token odds (logistic + peer record), validation suite (LOO, 80/20, walk-forward, CV AUC, bootstrap).

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ValidationMetrics {
  loo_median_abs_log_err: number;
  loo_within_2x_share: number;
  split_median_abs_log_err: number;
  split_within_2x_share: number;
  walk_forward_median_abs_log_err: number;
  cv_auc: number;
  bootstrap_slope_band: [number, number];
  coefficients: {
    intercept: number;
    log_tvl: number;
    log_tvl_sq: number;
    growth: number;
    log_age: number;
  };
  slope: number;
  intercept: number;
  r2: number;
}

export interface RadarConstants {
  growth_floor: number;
  growth_cap: number;
  unknown_age_days: number;
}

export const MODEL_CONSTANTS: RadarConstants = {
  growth_floor: -60,
  growth_cap: 120,
  unknown_age_days: 365,
};

export const MODEL_VERSION = 'radar-fitted-v2';
export const EARLY_ROWS = 400; // covers all 342 pre-token protocols
export const LIVE_ROWS = 24;

class NonFarmableCategoriesSet extends Set<string> {
  includes(value: string): boolean {
    return this.has(value);
  }
}

export const NON_FARMABLE_CATEGORIES = new NonFarmableCategoriesSet([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
]);

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  farmable: boolean;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  model: {
    base_multiple_fitted: number;
    growth_pct: number;
    token_odds: number;
    age_days: number | null;
    ev_usd: number;
    break_even_days: number;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  farmable: boolean;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  token_odds: number;
  ev_usd: number;
  break_even_days: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  validation: ValidationMetrics;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function slugHash(slug: string, seed: number = 0): number {
  let h = seed;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

// Matrix solver for OLS: solves (X^T X) beta = X^T y via Gaussian elimination with partial pivoting
function solveLinearSystem(xtx: number[][], xty: number[]): number[] {
  const n = xty.length;
  // Augment matrix [X^T X | X^T y]
  const aug: number[][] = [];
  for (let i = 0; i < n; i++) {
    aug[i] = [...xtx[i]!, xty[i]!];
  }

  for (let i = 0; i < n; i++) {
    // Pivot selection
    let maxRow = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(aug[r]![i]!) > Math.abs(aug[maxRow]![i]!)) {
        maxRow = r;
      }
    }
    const temp = aug[i]!;
    aug[i] = aug[maxRow]!;
    aug[maxRow] = temp;

    const pivot = aug[i]![i]!;
    if (Math.abs(pivot) < 1e-12) continue;

    for (let c = i; c <= n; c++) {
      aug[i]![c] /= pivot;
    }

    for (let r = 0; r < n; r++) {
      if (r !== i) {
        const factor = aug[r]![i]!;
        for (let c = i; c <= n; c++) {
          aug[r]![c] -= factor * aug[i]![c]!;
        }
      }
    }
  }

  const beta: number[] = [];
  for (let i = 0; i < n; i++) {
    beta[i] = aug[i]![n]!;
  }
  return beta;
}

export interface FittedModel {
  beta: number[]; // [intercept, log_tvl, log_tvl_sq, growth, log_age]
  r2: number;
  categoryAdjustments: Record<string, number>;
  medianAge: number;
}

function fitOLS(traded: SnapshotProtocol[], asOf: string, medianAgeOverride?: number): FittedModel {
  const points = traded.filter((p) => p.tvl_usd > 0 && p.mcap_usd !== null && p.mcap_usd > 0);
  const n = points.length;
  if (n === 0) {
    return { beta: [0, 1, 0, 0, 0], r2: 0, categoryAdjustments: {}, medianAge: 365 };
  }

  // Compute median age of traded protocols with valid listed_at
  const ages = points.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
  const medianAge = medianAgeOverride ?? (ages.length > 0 ? median(ages) : 365);

  const X: number[][] = [];
  const Y: number[] = [];

  for (const p of points) {
    const tvl = Math.max(1, p.tvl_usd);
    const logTvl = Math.log10(tvl);
    const growth = Math.min(MODEL_CONSTANTS.growth_cap, Math.max(MODEL_CONSTANTS.growth_floor, p.change_7d ?? 0));
    const age = ageDays(asOf, p.listed_at) ?? medianAge;
    const logAge = Math.log10(age + 1);
    const y = Math.log10(p.mcap_usd!);

    X.push([1, logTvl, logTvl * logTvl, growth, logAge]);
    Y.push(y);
  }

  const k = 5;
  const xtx: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const xty: number[] = Array(k).fill(0);

  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    const yi = Y[i]!;
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) {
        xtx[r]![c] += xi[r]! * xi[c]!;
      }
      xty[r] += xi[r]! * yi;
    }
  }

  const beta = solveLinearSystem(xtx, xty);

  // Calculate R2 and category residuals
  let sumY = 0;
  for (const y of Y) sumY += y;
  const meanY = sumY / n;

  let ssTot = 0;
  let ssRes = 0;
  const catMap = new Map<string, { residuals: number[] }>();

  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    const yi = Y[i]!;
    let pred = 0;
    for (let j = 0; j < k; j++) {
      pred += beta[j]! * xi[j]!;
    }
    ssTot += Math.pow(yi - meanY, 2);
    ssRes += Math.pow(yi - pred, 2);

    const cat = points[i]!.category;
    if (cat) {
      let entry = catMap.get(cat);
      if (!entry) {
        entry = { residuals: [] };
        catMap.set(cat, entry);
      }
      entry.residuals.push(yi - pred);
    }
  }

  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  const categoryAdjustments: Record<string, number> = {};
  for (const [cat, entry] of catMap.entries()) {
    const count = entry.residuals.length;
    if (count >= 5) {
      const meanRes = entry.residuals.reduce((a, b) => a + b, 0) / count;
      categoryAdjustments[cat] = meanRes * (count / (count + 5));
    } else {
      categoryAdjustments[cat] = 0;
    }
  }

  return { beta, r2, categoryAdjustments, medianAge };
}

// Predict mcap using fitted model
function predictMcap(p: SnapshotProtocol, fit: FittedModel, asOf: string): number {
  const tvl = Math.max(1, p.tvl_usd);
  const logTvl = Math.log10(tvl);
  const growth = Math.min(MODEL_CONSTANTS.growth_cap, Math.max(MODEL_CONSTANTS.growth_floor, p.change_7d ?? 0));
  const age = ageDays(asOf, p.listed_at) ?? fit.medianAge;
  const logAge = Math.log10(age + 1);

  const beta = fit.beta;
  const predLog = (beta[0] ?? 0) +
                  (beta[1] ?? 0) * logTvl +
                  (beta[2] ?? 0) * logTvl * logTvl +
                  (beta[3] ?? 0) * growth +
                  (beta[4] ?? 0) * logAge +
                  (p.category ? (fit.categoryAdjustments[p.category] ?? 0) : 0);

  return Math.pow(10, predLog);
}

// Token odds blend: 0.5 * logistic + 0.5 * peer-record
function fitTokenOdds(protocols: SnapshotProtocol[], asOf: string): (p: SnapshotProtocol) => number {
  const tradedSlugs = new Set(protocols.filter((p) => !isPreToken(p)).map((p) => p.slug));

  // Compute median age for odds imputation
  const ages = protocols.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
  const medAge = ages.length > 0 ? median(ages) : MODEL_CONSTANTS.unknown_age_days;

  const dataset = protocols.map((p) => {
    const tvl = Math.log10(Math.max(1, p.tvl_usd));
    const age = ageDays(asOf, p.listed_at) ?? medAge;
    const growth = Math.min(MODEL_CONSTANTS.growth_cap, Math.max(MODEL_CONSTANTS.growth_floor, p.change_7d ?? 0));
    const label = tradedSlugs.has(p.slug) ? 1 : 0;
    return { tvl, age, growth, label, category: p.category, rawTvl: p.tvl_usd, slug: p.slug };
  });

  const n = dataset.length;
  const meanTvl = dataset.reduce((a, d) => a + d.tvl, 0) / n;
  const meanAge = dataset.reduce((a, d) => a + d.age, 0) / n;
  const meanGrowth = dataset.reduce((a, d) => a + d.growth, 0) / n;

  const stdTvl = Math.sqrt(dataset.reduce((a, d) => a + Math.pow(d.tvl - meanTvl, 2), 0) / n) || 1;
  const stdAge = Math.sqrt(dataset.reduce((a, d) => a + Math.pow(d.age - meanAge, 2), 0) / n) || 1;
  const stdGrowth = Math.sqrt(dataset.reduce((a, d) => a + Math.pow(d.growth - meanGrowth, 2), 0) / n) || 1;

  let w = [0.5, 0.4, 0.1];
  let b = 0;
  const lr = 0.05;

  for (let iter = 0; iter < 80; iter++) {
    let dw = [0, 0, 0];
    let db = 0;
    for (const d of dataset) {
      const xtvl = (d.tvl - meanTvl) / stdTvl;
      const xage = (d.age - meanAge) / stdAge;
      const xgrowth = (d.growth - meanGrowth) / stdGrowth;
      const z = w[0]! * xtvl + w[1]! * xage + w[2]! * xgrowth + b;
      const pred = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
      const err = pred - d.label;
      dw[0] += err * xtvl;
      dw[1] += err * xage;
      dw[2] += err * xgrowth;
      db += err;
    }
    w[0] -= lr * (dw[0] / n);
    w[1] -= lr * (dw[1] / n);
    w[2] -= lr * (dw[2] / n);
    b -= lr * (db / n);
  }

  // Global rate fallback
  const globalTradedCount = dataset.filter((d) => d.label === 1).length;
  const globalRate = globalTradedCount / n;

  // Category rates fallback
  const catRates = new Map<string, number>();
  const catCounts = new Map<string, number>();
  for (const d of dataset) {
    if (!d.category) continue;
    catCounts.set(d.category, (catCounts.get(d.category) ?? 0) + 1);
    if (d.label === 1) {
      catRates.set(d.category, (catRates.get(d.category) ?? 0) + 1);
    }
  }
  const categoryBaseRate = new Map<string, number>();
  for (const [cat, count] of catCounts.entries()) {
    const tradedC = catRates.get(cat) ?? 0;
    categoryBaseRate.set(cat, count >= 5 ? tradedC / count : globalRate);
  }

  return (p: SnapshotProtocol) => {
    // 1. Logistic probability
    const tvl = Math.log10(Math.max(1, p.tvl_usd));
    const age = ageDays(asOf, p.listed_at) ?? medAge;
    const growth = Math.min(MODEL_CONSTANTS.growth_cap, Math.max(MODEL_CONSTANTS.growth_floor, p.change_7d ?? 0));
    const xtvl = (tvl - meanTvl) / stdTvl;
    const xage = (age - meanAge) / stdAge;
    const xgrowth = (growth - meanGrowth) / stdGrowth;
    const z = w[0]! * xtvl + w[1]! * xage + w[2]! * xgrowth + b;
    const logProb = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));

    // 2. Peer-record probability
    // Same-category + TVL +/- 0.5 dex peers, min 8, fallback to category rate min 10, then global rate
    let peerRate = globalRate;
    if (p.category) {
      const peers = dataset.filter((d) => d.category === p.category && Math.abs(d.tvl - tvl) <= 0.5);
      if (peers.length >= 8) {
        const tradedPeers = peers.filter((d) => d.label === 1).length;
        peerRate = tradedPeers / peers.length;
      } else {
        const catPeers = dataset.filter((d) => d.category === p.category);
        if (catPeers.length >= 10) {
          const tradedCat = catPeers.filter((d) => d.label === 1).length;
          peerRate = tradedCat / catPeers.length;
        } else {
          peerRate = categoryBaseRate.get(p.category) ?? globalRate;
        }
      }
    }

    const blend = 0.5 * logProb + 0.5 * peerRate;
    return Math.max(0.02, Math.min(0.95, blend));
  };
}

// Compute AUC for ROC evaluation
function computeAUC(labels: number[], scores: number[]): number {
  const n = labels.length;
  if (n === 0) return 0.5;
  const indexed = scores.map((s, i) => ({ s, l: labels[i]! }));
  indexed.sort((a, b) => a.s - b.s);

  let positives = 0;
  let negatives = 0;
  for (const item of indexed) {
    if (item.l === 1) positives++;
    else negatives++;
  }
  if (positives === 0 || negatives === 0) return 0.5;

  let accum = 0;
  let currentNegatives = 0;
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    let tiePos = 0;
    let tieNeg = 0;
    while (j < indexed.length && indexed[j]!.s === indexed[i]!.s) {
      if (indexed[j]!.l === 1) tiePos++;
      else tieNeg++;
      j++;
    }
    accum += tiePos * (currentNegatives + tieNeg / 2);
    currentNegatives += tieNeg;
    i = j;
  }
  return accum / (positives * negatives);
}

// 5-fold CV AUC for odds blend
function computeCVAUC(protocols: SnapshotProtocol[], asOf: string): number {
  const tradedSlugs = new Set(protocols.filter((p) => !isPreToken(p)).map((p) => p.slug));
  const labels = protocols.map((p) => (tradedSlugs.has(p.slug) ? 1 : 0));

  // We can compute out-of-fold scores using 5 folds
  const kFolds = 5;
  const scores: number[] = Array(protocols.length).fill(0.5);

  for (let fold = 0; fold < kFolds; fold++) {
    const trainProtocols = protocols.filter((_, idx) => idx % kFolds !== fold);
    const testProtocols = protocols.filter((_, idx) => idx % kFolds === fold);
    const oddsFn = fitTokenOdds(trainProtocols, asOf);
    for (const p of testProtocols) {
      const origIdx = protocols.findIndex((item) => item.slug === p.slug);
      if (origIdx >= 0) {
        scores[origIdx] = oddsFn(p);
      }
    }
  }

  return computeAUC(labels, scores);
}

// Validation suite
function validateModel(protocols: SnapshotProtocol[], asOf: string): ValidationMetrics {
  const traded = protocols.filter((p) => !isPreToken(p) && p.tvl_usd > 0 && p.mcap_usd !== null && p.mcap_usd > 0);
  const N = traded.length;

  // 1. Leave-One-Out (LOO)
  const looErrors: number[] = [];
  let looWithin2x = 0;
  for (let i = 0; i < N; i++) {
    const train = traded.filter((_, idx) => idx !== i);
    const test = traded[i]!;
    const fit = fitOLS(train, asOf);
    const y = Math.log10(test.mcap_usd!);
    const predY = Math.log10(predictMcap(test, fit, asOf));
    const err = Math.abs(predY - y);
    looErrors.push(err);
    if (err <= Math.log10(2)) looWithin2x++;
  }
  const loo_median_abs_log_err = median(looErrors);
  const loo_within_2x_share = looWithin2x / N;

  // 2. 50x repeated 80/20 splits (median error)
  const splitErrors: number[] = [];
  let splitWithin2xTotal = 0;
  let splitCount = 0;

  for (let seed = 1; seed <= 50; seed++) {
    const trainSet = traded.filter((p) => slugHash(p.slug, seed) >= 20);
    const testSet = traded.filter((p) => slugHash(p.slug, seed) < 20);
    const activeTrain = trainSet.length >= 10 ? trainSet : traded;
    const activeTest = testSet.length > 0 ? testSet : traded;

    const fit = fitOLS(activeTrain, asOf);
    for (const test of activeTest) {
      const y = Math.log10(test.mcap_usd!);
      const predY = Math.log10(predictMcap(test, fit, asOf));
      const err = Math.abs(predY - y);
      splitErrors.push(err);
      if (err <= Math.log10(2)) splitWithin2xTotal++;
      splitCount++;
    }
  }
  const split_median_abs_log_err = median(splitErrors);
  const split_within_2x_share = splitCount > 0 ? splitWithin2xTotal / splitCount : 0.33;

  // 3. Walk-forward (time-ordered split: train on earlier-listed half, test on later-listed half)
  const sortedTraded = [...traded].sort((a, b) => {
    const ta = a.listed_at ? Date.parse(a.listed_at) : 0;
    const tb = b.listed_at ? Date.parse(b.listed_at) : 0;
    return ta - tb;
  });
  const midIdx = Math.floor(sortedTraded.length / 2);
  const wfTrain = sortedTraded.slice(0, midIdx);
  const wfTest = sortedTraded.slice(midIdx);
  const wfFit = fitOLS(wfTrain.length >= 10 ? wfTrain : traded, asOf);
  const wfErrors: number[] = [];
  for (const test of (wfTest.length > 0 ? wfTest : traded)) {
    const y = Math.log10(test.mcap_usd!);
    const predY = Math.log10(predictMcap(test, wfFit, asOf));
    wfErrors.push(Math.abs(predY - y));
  }
  const walk_forward_median_abs_log_err = median(wfErrors);

  // 4. CV AUC
  const cv_auc = computeCVAUC(protocols, asOf);

  // 5. Bootstrap band (200 resamples)
  const bootstrapSlopes: number[] = [];
  for (let b = 0; b < 200; b++) {
    const resampled: SnapshotProtocol[] = [];
    let seed = 2026 + b * 13;
    for (let j = 0; j < N; j++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const idx = Math.floor((seed / 2147483648) * N);
      resampled.push(traded[idx]!);
    }
    const fitB = fitOLS(resampled, asOf);
    bootstrapSlopes.push(fitB.beta[1]!); // log_tvl coefficient
  }
  bootstrapSlopes.sort((a, b) => a - b);
  const slope10th = bootstrapSlopes[Math.floor(200 * 0.1)] ?? bootstrapSlopes[0]!;
  const slope90th = bootstrapSlopes[Math.floor(200 * 0.9)] ?? bootstrapSlopes[bootstrapSlopes.length - 1]!;

  const fullFit = fitOLS(traded, asOf);

  return {
    loo_median_abs_log_err: Math.round(loo_median_abs_log_err * 1000) / 1000,
    loo_within_2x_share: Math.round(loo_within_2x_share * 1000) / 1000,
    split_median_abs_log_err: Math.round(split_median_abs_log_err * 1000) / 1000,
    split_within_2x_share: Math.round(split_within_2x_share * 1000) / 1000,
    walk_forward_median_abs_log_err: Math.round(walk_forward_median_abs_log_err * 1000) / 1000,
    cv_auc: Math.round(cv_auc * 1000) / 1000,
    bootstrap_slope_band: [Math.round(slope10th * 1000) / 1000, Math.round(slope90th * 1000) / 1000],
    coefficients: {
      intercept: Math.round(fullFit.beta[0]! * 10000) / 10000,
      log_tvl: Math.round(fullFit.beta[1]! * 10000) / 10000,
      log_tvl_sq: Math.round(fullFit.beta[2]! * 10000) / 10000,
      growth: Math.round(fullFit.beta[3]! * 10000) / 10000,
      log_age: Math.round(fullFit.beta[4]! * 10000) / 10000,
    },
    slope: Math.round(fullFit.beta[1]! * 1000) / 1000,
    intercept: Math.round(fullFit.beta[0]! * 1000) / 1000,
    r2: Math.round(fullFit.r2 * 1000) / 1000,
  };
}

// Farm steps generation (category-aware, supporting Risk Curator / RWA / perps / Lending / Dexs / etc.)
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

export function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;

  let action = `Deposit $${capital} of USDC into ${name} on ${chain} and maintain the liquidity position.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    action = `Supply $${capital} of USDC as collateral and borrow a conservative stable position on ${name} on ${chain}.`;
  } else if (c.includes('dex') || c.includes('yield') || c.includes('swap')) {
    action = `Provide $${capital} of liquidity to the primary liquidity pool on ${name} on ${chain} and hold LP shares.`;
  } else if (c.includes('allocator') || c.includes('curator') || c.includes('risk')) {
    action = `Deposit $${capital} into a managed allocation strategy vault on ${name} on ${chain} and retain vault shares.`;
  } else if (c.includes('rwa')) {
    action = `Mint $${capital} equivalent of yield-bearing real-world asset tokens through ${name} on ${chain}.`;
  } else if (c.includes('perpetual') || c.includes('derivative')) {
    action = `Deposit $${capital} of USDC margin and execute a hedged perpetual trading position on ${name} on ${chain}.`;
  } else if (c.includes('restak') || c.includes('liquid staking')) {
    action = `Restake $${capital} of liquid staking tokens through ${name} on ${chain} to secure active network validation.`;
  } else if (c.includes('insurance')) {
    action = `Purchase $${capital} of coverage protection policy on ${name} on ${chain} and keep coverage active.`;
  }

  const hold = age !== null && age < 180 ? 60 : 30;

  return [
    {
      text: `Prepare a dedicated non-custodial wallet funded with native gas tokens on ${chain} and keep seed credentials secure.`,
      cost: 'under $3 of gas for setup',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} capital and ~$5 network fee`,
      time: '15 minutes',
    },
    {
      text: `Perform weekly protocol interactions such as compounding rewards, rebalancing collateral, or participating in governance votes.`,
      cost: '$1-$2 weekly gas',
      time: '10 minutes weekly',
    },
    {
      text: `Maintain the active farm position for at least ${hold} consecutive days across snapshot update cycles.`,
      cost: `capital locked (${hold} days)`,
      time: `${hold} days`,
    },
    {
      text: `Navigate exclusively to the official verified ${name} application interface to claim rewards or airdrop allocations.`,
      cost: 'zero fees',
      time: '5 minutes',
    },
  ];
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep position active and monitor protocol announcements.`;
  return s;
}

export function honestFarmSteps(category: string | null): string[] {
  const isCex = category === 'CEX';
  const label = isCex ? 'centralized exchange' : 'bridge';
  return [
    `This protocol is a ${label}: there is no on-chain interaction that farms a token launch, and deposits here do not earn a future token allocation.`,
    `Watch for an official token announcement from the protocol itself; if a launch ever happens it will be announced through official channels, not through third-party farm guides.`,
    `Do not trust unofficial guides that tell you to farm this protocol, and do not deposit funds expecting a token — there is no interaction path to farm.`,
  ];
}

/**
 * EV per $1,000 farmed = implied_value_usd * 5e-6.
 * FARM > $50, THIN $10-50, SKIP < $10.
 */
export function computeVerdict(impliedValueUsd: number, farmable: boolean = true): 'FARM' | 'THIN' | 'SKIP' {
  const ev = impliedValueUsd * 5e-6;
  let v: 'FARM' | 'THIN' | 'SKIP' = 'SKIP';
  if (ev > 50) v = 'FARM';
  else if (ev >= 10) v = 'THIN';
  else v = 'SKIP';
  if (!farmable && v === 'FARM') v = 'THIN';
  return v;
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const traded = snapshot.protocols.filter((p) => !isPreToken(p));
  const fit = fitOLS(traded, snapshot.as_of);
  const validation = validateModel(snapshot.protocols, snapshot.as_of);
  const oddsFn = fitTokenOdds(snapshot.protocols, snapshot.as_of);

  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();

  // Floor: all watchlist protocols
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

  // Early radar: rank ALL pre-token protocols (up to EARLY_ROWS, covering all 342 pre-token protocols)
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);

  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const baseVal = predictMcap(p, fit, snapshot.as_of);
    const odds = oddsFn(p);
    const implied = Math.max(1, Math.round(baseVal * odds));
    const capital = capitalFor(p);
    const farmable = p.category === null || !NON_FARMABLE_CATEGORIES.has(p.category);
    const verdict = computeVerdict(implied, farmable);
    const ev = Math.round(implied * 5e-6 * 100) / 100;
    const breakEvenDays = Math.max(7, Math.round(30 / Math.max(0.1, ev / 10)));

    return {
      p,
      implied,
      odds,
      age,
      farmable,
      verdict,
      ev,
      breakEvenDays,
    };
  });

  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    farmable: s.farmable,
    verdict: s.verdict,
    model: {
      base_multiple_fitted: Math.round(predictMcap(s.p, fit, snapshot.as_of) * 1e4) / 1e4,
      growth_pct: s.p.change_7d ?? 0,
      token_odds: Math.round(s.odds * 1e4) / 1e4,
      age_days: s.age,
      ev_usd: s.ev,
      break_even_days: s.breakEvenDays,
    },
    farm_steps: s.farmable ? farmSteps(s.p, s.age).map(stepText) : honestFarmSteps(s.p.category),
  }));

  const live = liveRows(snapshot);
  const earlyCount = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    validation,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlyCount,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      mcap_usd: r.mcap_usd,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      farmable: r.farmable,
      verdict: r.verdict,
      token_odds: r.model.token_odds,
      ev_usd: r.model.ev_usd,
      break_even_days: r.model.break_even_days,
      farm_steps: r.farm_steps,
    })),
    live,
  };

  return { board, radar };
}

export const buildRadar = buildBoard;

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');

  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });

  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
