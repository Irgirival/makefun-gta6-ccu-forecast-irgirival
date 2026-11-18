// GTA VI Twitch CCU forecast — regime-analog forecaster.
//
// make.fun competition gta6-twitch-ccu-forecast-01.
// Forecasts, for hours 2..24 of a launch day (UTC), five quantiles of the
// Twitch category's concurrent viewers, from the case file alone (offline,
// deterministic, standard library only).
//
// Method (regime / analog, no Bayesian hierarchy, no fitted global model):
//   1. Every comparable past launch in the case is reduced to its release-day
//      shape: log(V[h] / V[1]) for h = 2..24, plus four features known at the
//      checkpoint — hour-1 scale, launch multiplier vs its quiet pre-release
//      baseline, viewers-per-channel at hour 1, and the pre-release ramp in
//      the last day. The same four features are computed for the target launch
//      from its own history and its hour-1 print.
//   2. Analogs are weighted by a Gaussian kernel on the feature distance:
//      launches that looked like this launch at hour 1 count more. The
//      forecast median for each hour is the kernel-weighted median of the
//      analogs' log-ratios, shrunk toward the unweighted median of all
//      analogs when few close analogs exist, then lightly smoothed across
//      neighbouring hours (unlock waves move smoothly; a jagged median is
//      different analogs peaking at different hours, not signal).
//   3. The spread for each hour is the kernel-weighted dispersion of the
//      analogs' log-ratios at that hour, floored and scaled by a calibrated
//      factor (see calibration.json). Quantiles are log-normal around the
//      median with that spread.
//   4. Fallback: if no usable analog exists, the house persistence baseline.
//      Output is always valid: 23 rows, hours 2..24, five non-decreasing
//      quantiles in (0, 1e9].
//
// Calibration: the constants in calibration.json were tuned by
// leave-one-out backtest over the 38 comparable launches in the kit's
// practice cases (each launch forecast from its hour 1 using the other 37
// as analogs, scored by the contest's pinball loss on the log scale).
// See CALIBRATION.md for the numbers and the comparison with the house
// baseline. Nothing here is fitted to the four practice targets themselves:
// their answers are not in the kit.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

interface HourlyPoint {
  from: string;
  viewers: number;
  channels?: number | null;
  reads?: number;
}
interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly: HourlyPoint[];
}
interface CaseFile {
  id: string;
  game?: { name?: string; twitch_id?: string };
  day_start: string;
  checkpoint: string;
  levels?: number[];
  known: Array<{ hour: number; viewers: number; channels?: number | null; reads?: number }>;
  forecast: Array<{ hour: number }>;
  history?: Array<{ at: string; viewers: number; channels?: number | null }>;
  history_hourly?: HourlyPoint[];
  streams?: Array<{ login: string; viewers: number }> | null;
  categories_hourly?: unknown;
  comparables: Comparable[];
  notes?: string;
}

interface Calibration {
  /** Per-feature kernel weight (distance is weighted Euclidean in log space). */
  featureWeights: { logV1: number; logM: number; logVpc: number; logRamp: number };
  /** Per-feature scale (one standard distance unit) in log space. */
  featureScales: { logV1: number; logM: number; logVpc: number; logRamp: number };
  /** Prior strength (in effective-analog units) pulling medians to the global median curve. */
  priorStrength: number;
  /** Multiplicative factor on the analog dispersion that becomes the log spread. */
  spreadFactor: number;
  /** Floor on the log spread per hour. */
  spreadFloor: number;
  /** Cap on the log spread per hour. */
  spreadCap: number;
  /** Extra spread factor when the effective analog count is low (0 = off). */
  sparseSpread: number;
  /** 3-hour median smoothing of the median curve (true/false). */
  smoothMedian: boolean;
  /** Minimum release-day hours an analog must have to count. */
  minAnalogHours: number;
  /** Weight multiplier for an analog whose unlock regime differs from the target's. */
  regimeMismatch: number;
  /** Weight multiplier when either side is the delayed-unlock regime and they differ. */
  delayedMismatch: number;
  /** Weight multiplier for analogs tagged a weak tier (free-to-play, slow-burn). */
  weakTierWeight: number;
  /** Blend of weighted median (1) and weighted mean (0) of analog log-ratios. */
  medianBlend: number;
}

const DEFAULT_CALIBRATION: Calibration = {
  featureWeights: { logV1: 1.0, logM: 1.0, logVpc: 0.5, logRamp: 1.0 },
  featureScales: { logV1: 1.5, logM: 2.0, logVpc: 0.7, logRamp: 1.0 },
  priorStrength: 0.5,
  spreadFactor: 0.7,
  spreadFloor: 0.15,
  spreadCap: 1.0,
  sparseSpread: 0.5,
  smoothMedian: true,
  minAnalogHours: 12,
  regimeMismatch: 0.15,
  delayedMismatch: 0.05,
  weakTierWeight: 0.3,
  medianBlend: 1.0,
};

function loadCalibration(): Calibration {
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    const path = join(root, 'calibration.json');
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Calibration>;
      return { ...DEFAULT_CALIBRATION, ...raw };
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_CALIBRATION;
}

const CAL = loadCalibration();

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round2 = (x: number): number => Math.round(x * 100) / 100;
/** Median of numbers (sorted copy); null when empty. */
function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Weighted median: smallest x with cumulative weight >= half the total. */
function weightedMedian(pairs: Array<{ x: number; w: number }>): number | null {
  if (!pairs.length) return null;
  const s = [...pairs].sort((a, b) => a.x - b.x || (a.w - b.w));
  const total = s.reduce((t, p) => t + p.w, 0);
  let acc = 0;
  for (const p of s) {
    acc += p.w;
    if (acc >= total / 2) return p.x;
  }
  return s[s.length - 1].x;
}
/** Weighted mean and (population) weighted standard deviation. */
function weightedMeanStd(pairs: Array<{ x: number; w: number }>): { mean: number; std: number } {
  const total = pairs.reduce((t, p) => t + p.w, 0);
  if (total <= 0) return { mean: 0, std: 0 };
  const mean = pairs.reduce((t, p) => t + p.w * p.x, 0) / total;
  const variance = pairs.reduce((t, p) => t + p.w * (p.x - mean) * (p.x - mean), 0) / total;
  return { mean, std: Math.sqrt(Math.max(0, variance)) };
}

/**
 * The four checkpoint-known features of a launch, from its hourly points.
 * `dayStartMs` is the release day's 00:00 UTC; `hour1Viewers`/`hour1Channels`
 * are the hour-1 print. All features are in log space; a feature is null
 * when its inputs are missing, and null features are skipped in distances.
 */
interface Features {
  logV1: number | null;
  logM: number | null;
  logVpc: number | null;
  logRamp: number | null;
}
function extractFeatures(
  hourly: HourlyPoint[],
  dayStartMs: number,
  hour1Viewers: number,
  hour1Channels: number | null,
): Features {
  const logV1 = hour1Viewers > 0 ? Math.log(hour1Viewers) : null;
  // Quiet pre-release baseline: median hourly viewers in [day-7, day-1).
  const baseVals: number[] = [];
  // Pre-release ramp: median of the last 6h before the day vs the day before that.
  const last6: number[] = [];
  const prevDay: number[] = [];
  for (const p of hourly) {
    if (p.viewers == null || !(p.viewers > 0)) continue;
    const t = Date.parse(p.from);
    if (Number.isNaN(t)) continue;
    if (t >= dayStartMs - 7 * DAY_MS && t < dayStartMs - DAY_MS) baseVals.push(p.viewers);
    if (t >= dayStartMs - 6 * HOUR_MS && t < dayStartMs) last6.push(p.viewers);
    if (t >= dayStartMs - 2 * DAY_MS && t < dayStartMs - DAY_MS) prevDay.push(p.viewers);
  }
  const base = median(baseVals);
  const logM = base != null && base > 0 && logV1 != null ? logV1 - Math.log(base) : null;
  const logVpc =
    hour1Channels != null && hour1Channels > 0 && hour1Viewers > 0
      ? Math.log(hour1Viewers / hour1Channels)
      : null;
  const m6 = median(last6);
  const mPrev = median(prevDay);
  const logRamp = m6 != null && mPrev != null && mPrev > 0 ? Math.log(m6 / mPrev) : null;
  return { logV1, logM, logVpc, logRamp };
}

/** Release-day unlock regime, parsed from a launch's unlock description
 * (a comparable's `unlock` text, or the target's `notes`). The regime is what
 * decides the SHAPE of the day-1 curve, and it is knowable at hour 1:
 *   early   — paid early access ran before release day, so hour 1 is already
 *             hot and the day stays flat (peak / hour-1 ~ 1.0-1.9x).
 *   rolling — midnight-local rolling unlock, no early access: hour 1 holds
 *             only the regions already past midnight; the curve rises as the
 *             US unlocks and prime time arrives (peak / hour-1 ~ 1.7-12x,
 *             smaller when hour 1 is already big).
 *   front   — one global unlock at or before 00:00Z of the release day
 *             (PC global unlock the night before): hour 1 IS the peak.
 *   delayed — one global unlock during the release day (e.g. 14:00Z): hour 1
 *             is pre-unlock and tiny; the curve explodes at the unlock hour.
 * Parse order matters: early access first (it dominates even a rolling
 * unlock), then rolling midnight-local, then a single global unlock timed
 * against the release day. Anything unparseable defaults to rolling, the
 * commonest shape. */
type Regime = 'early' | 'rolling' | 'front' | 'delayed';
export function parseRegime(text: string, dayStartMs: number): Regime {
  const t = text ?? '';
  if (/early access/i.test(t) && !/no early access/i.test(t) && !/campaign early access/i.test(t)) return 'early';
  // A single global / simultaneous unlock already live by the end of hour 1
  // dominates everything else: hour 1 IS the peak (front).
  let globalWhen: number | null = null;
  let globalHour: number | null = null;
  if (/global|simultaneous/i.test(t)) {
    const iso = t.match(/(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})Z/);
    if (iso) globalWhen = Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5]);
    const bare = t.match(/(\d{1,2}):(\d{2})\s*Z/);
    if (bare) globalHour = parseInt(bare[1], 10);
  }
  if (globalWhen != null && globalWhen <= dayStartMs + HOUR_MS) return 'front';
  if (globalHour != null && globalHour <= 1) return 'front';
  if (/midnight local/i.test(t) || /12 AM local/i.test(t) || /rolling/i.test(t)) return 'rolling';
  if (globalWhen != null && globalWhen < dayStartMs + DAY_MS) return 'delayed';
  if (globalHour != null) return 'delayed';
  return 'rolling';
}

/** 'weak' when the unlock text tags the launch a weak tier (free-to-play,
 * slow-burn): a poor analog for a paid single-player launch. */
function isWeakTier(text: string): boolean {
  return /Tier:\s*weak/i.test(text ?? '');
}

/** Release-day hourly viewers of a comparable, keyed by hour 1..24. */
function releaseDayCurve(comp: Comparable): Map<number, number> {
  const start = Date.parse(comp.day_start);
  const out = new Map<number, number>();
  if (Number.isNaN(start)) return out;
  for (const p of comp.hourly) {
    if (p.viewers == null || !(p.viewers > 0)) continue;
    const t = Date.parse(p.from);
    if (Number.isNaN(t)) continue;
    const h = Math.floor((t - start) / HOUR_MS) + 1;
    if (h >= 1 && h <= 24 && !out.has(h)) out.set(h, p.viewers);
  }
  return out;
}

/** Gaussian-kernel distance between target and analog features (0 = identical). */
function featureDistance(a: Features, b: Features): number {
  const w = CAL.featureWeights;
  const s = CAL.featureScales;
  let sum = 0;
  let used = 0;
  const terms: Array<[number | null, number | null, number, number]> = [
    [a.logV1, b.logV1, w.logV1, s.logV1],
    [a.logM, b.logM, w.logM, s.logM],
    [a.logVpc, b.logVpc, w.logVpc, s.logVpc],
    [a.logRamp, b.logRamp, w.logRamp, s.logRamp],
  ];
  for (const [x, y, weight, scale] of terms) {
    if (x == null || y == null) continue;
    const d = (x - y) / scale;
    sum += weight * d * d;
    used += weight;
  }
  if (used === 0) return Number.POSITIVE_INFINITY;
  return Math.sqrt(sum / used);
}

/** The house persistence baseline: every hour at the hour-1 print, widening spread. */
function houseBaselineRows(p1: number): Array<{ hour: number; q: number[] }> {
  const rows: Array<{ hour: number; q: number[] }> = [];
  for (let h = 2; h <= 24; h++) {
    const q = Z.map((z) => round2(Math.max(1, p1 * Math.exp(z * 0.15 * Math.sqrt(h - 1)))));
    rows.push({ hour: h, q });
  }
  return rows;
}

export function forecastCase(c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  const knownRow = c.known?.[0];
  const p1 = Math.max(1, knownRow?.viewers && knownRow.viewers > 0 ? knownRow.viewers : 1);
  const c1 = knownRow?.channels != null && knownRow.channels > 0 ? knownRow.channels : null;
  const dayStartMs = Date.parse(c.day_start);

  // Target features from its own pre-release hourly history + hour 1.
  const targetHourly: HourlyPoint[] = [...(c.history_hourly ?? [])];
  // history_hourly may be empty in odd cases; fall back to raw history points.
  if (!targetHourly.length && c.history?.length) {
    for (const p of c.history) targetHourly.push({ from: p.at, viewers: p.viewers, channels: p.channels ?? null });
  }
  const targetFeatures = extractFeatures(targetHourly, dayStartMs, p1, c1);
  const targetRegime = parseRegime(c.notes ?? '', dayStartMs);

  // Build the analog set: comparables with a usable release day.
  interface Analog {
    name: string;
    weight: number;
    curve: Map<number, number>;
    logRatio: Map<number, number>;
  }
  const analogs: Analog[] = [];
  for (const comp of c.comparables ?? []) {
    const curve = releaseDayCurve(comp);
    if (!curve.has(1) || curve.size < CAL.minAnalogHours) continue;
    const v1 = curve.get(1) as number;
    const ch1 = comp.hourly.find((p) => Date.parse(p.from) === Date.parse(comp.day_start))?.channels ?? null;
    const feats = extractFeatures(comp.hourly, Date.parse(comp.day_start), v1, ch1 ?? null);
    const d = featureDistance(targetFeatures, feats);
    if (!Number.isFinite(d)) continue;
    // Regime gate: launches that unlocked differently shape the day
    // differently; a different regime is down-weighted hard, a delayed
    // unlock (pre-unlock hour 1) hardest of all. Weak-tier launches
    // (free-to-play, slow-burn) are poor analogs for a paid launch.
    const reg = parseRegime(comp.unlock ?? '', Date.parse(comp.day_start));
    const regimeFactor =
      reg === targetRegime
        ? 1
        : reg === 'delayed' || targetRegime === 'delayed'
          ? CAL.delayedMismatch
          : CAL.regimeMismatch;
    const tierFactor = isWeakTier(comp.unlock ?? '') ? CAL.weakTierWeight : 1;
    const weight = Math.exp(-0.5 * d * d) * regimeFactor * tierFactor;
    const logRatio = new Map<number, number>();
    for (const [h, v] of curve) logRatio.set(h, Math.log(v / v1));
    analogs.push({ name: comp.name, weight, curve, logRatio });
  }

  if (!analogs.length) return { hours: houseBaselineRows(p1) };

  // Global (unweighted) median log-ratio curve, for shrinkage.
  const globalMedian = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const vals: number[] = [];
    for (const a of analogs) {
      const lr = a.logRatio.get(h);
      if (lr != null) vals.push(lr);
    }
    const m = median(vals);
    if (m != null) globalMedian.set(h, m);
  }

  // Top-stream concentration widens the spread a little when one broadcast
  // carries the category (event-driven hour 1): bounded, and only when the
  // case carries streams at all (null in practice cases).
  let concentration = 0;
  if (c.streams?.length && p1 > 0) {
    const top = Math.max(...c.streams.map((s) => s.viewers || 0));
    concentration = clamp(top / p1, 0, 0.8);
  }

  const medCurve = new Map<number, number>();
  const sigmaCurve = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const pairs: Array<{ x: number; w: number }> = [];
    let wSum = 0;
    for (const a of analogs) {
      const lr = a.logRatio.get(h);
      if (lr == null) continue;
      pairs.push({ x: lr, w: a.weight });
      wSum += a.weight;
    }
    if (!pairs.length) {
      // No analog has this hour: fall back to the global median, wide spread.
      const g = globalMedian.get(h);
      medCurve.set(h, g ?? 0);
      sigmaCurve.set(h, CAL.spreadCap);
      continue;
    }
    const wm = weightedMedian(pairs) ?? 0;
    const { mean: wmean } = weightedMeanStd(pairs);
    const blended = CAL.medianBlend * wm + (1 - CAL.medianBlend) * wmean;
    const g = globalMedian.get(h) ?? blended;
    const wEff = wSum; // effective analog weight at this hour
    const med = (wEff * blended + CAL.priorStrength * g) / (wEff + CAL.priorStrength);
    medCurve.set(h, med);
    const { std } = weightedMeanStd(pairs);
    let sigma = CAL.spreadFactor * std;
    sigma *= 1 + CAL.sparseSpread * (CAL.priorStrength / (wEff + CAL.priorStrength));
    sigma *= 1 + 0.3 * concentration;
    sigmaCurve.set(h, clamp(sigma, CAL.spreadFloor, CAL.spreadCap));
  }

  // Light 3-hour median smoothing of the median curve (unlock waves are
  // smooth; a jagged median is analogs peaking at different hours).
  let medFinal = medCurve;
  if (CAL.smoothMedian) {
    const smoothed = new Map<number, number>();
    for (let h = 2; h <= 24; h++) {
      const vals: number[] = [];
      for (const hh of [h - 1, h, h + 1]) {
        if (hh >= 2 && hh <= 24) {
          const v = medCurve.get(hh);
          if (v != null) vals.push(v);
        }
      }
      const m = median(vals);
      smoothed.set(h, m ?? medCurve.get(h) ?? 0);
    }
    medFinal = smoothed;
  }

  const hours: Array<{ hour: number; q: number[] }> = [];
  for (let h = 2; h <= 24; h++) {
    const med = medFinal.get(h) ?? 0;
    const sigma = sigmaCurve.get(h) ?? CAL.spreadFloor;
    let q = Z.map((z) => round2(clamp(p1 * Math.exp(med + z * sigma), 1, 1e9)));
    // Enforce non-decreasing (rounding can tie, never invert, but be safe).
    for (let i = 1; i < q.length; i++) q[i] = Math.max(q[i], q[i - 1]);
    hours.push({ hour: h, q });
  }
  return { hours };
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const files = readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith('.in'))
    .sort();
  for (const f of files) {
    const raw = readFileSync(join(INPUT_DIR, f), 'utf8');
    const c = JSON.parse(raw) as CaseFile;
    const id = f.replace(/\.in$/, '');
    const out = forecastCase(c);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), JSON.stringify(out));
  }
}

if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
