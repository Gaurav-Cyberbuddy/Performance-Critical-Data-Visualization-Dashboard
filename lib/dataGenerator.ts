export interface DataPoint {
  timestamp: number; // ms epoch
  value: number;
  category: string;
  volume: number;
}

export const CATEGORIES = ['CPU', 'Memory', 'Network', 'Disk I/O'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Generates a large synthetic time-series dataset with metric-specific
 * behavior so the chart reads like a real monitoring system rather than
 * point-to-point noise.
 *
 * Deterministic via seeded PRNG so regenerating with the same size is stable.
 */
export function generateDataset(size: number): DataPoint[] {
  const data: DataPoint[] = [];
  const now = Date.now();
  const intervalMs = 1000; // 1 point per second per category

  let seed = 42;
  const rand = () => {
    // mulberry32 — fast, no external deps
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const perCategory = Math.ceil(size / CATEGORIES.length);

  CATEGORIES.forEach((category) => {
    let value = 50;
    let memoryDrift = 0;
    let burstRemaining = 0;
    let burstLevel = 0;

    if (category === 'CPU') value = 52;
    else if (category === 'Memory') value = 48;
    else if (category === 'Network') value = 12;
    else value = 28; // Disk I/O

    for (let i = 0; i < perCategory; i++) {
      const t = i / perCategory;

      if (category === 'CPU') {
        // Smooth mid-range load with slow wave + rare spikes into 85–95%
        const wave = Math.sin(t * Math.PI * 6) * 8 + Math.sin(t * Math.PI * 1.7) * 5;
        value = 55 + wave + (rand() - 0.5) * 3;
        if (rand() > 0.992) value = 85 + rand() * 10;
        else if (rand() > 0.97) value += 12 + rand() * 8;
      } else if (category === 'Memory') {
        // Gradual trend with low noise and occasional step changes
        memoryDrift += (rand() - 0.48) * 0.08;
        memoryDrift = Math.max(-18, Math.min(22, memoryDrift));
        if (rand() > 0.998) memoryDrift += (rand() - 0.3) * 8;
        value = 48 + memoryDrift + Math.sin(t * Math.PI * 2) * 2 + (rand() - 0.5) * 1.2;
      } else if (category === 'Network') {
        // Quiet baseline with burst/spike windows
        if (burstRemaining > 0) {
          burstRemaining--;
          value = burstLevel + (rand() - 0.5) * 8;
        } else {
          value = 8 + Math.sin(t * Math.PI * 4) * 3 + (rand() - 0.5) * 4;
          if (rand() > 0.988) {
            burstRemaining = 8 + Math.floor(rand() * 20);
            burstLevel = 55 + rand() * 40;
            value = burstLevel;
          }
        }
      } else {
        // Disk I/O: mostly moderate, occasional high activity
        const wave = Math.sin(t * Math.PI * 3.2) * 6;
        value = 30 + wave + (rand() - 0.5) * 5;
        if (rand() > 0.99) value = 70 + rand() * 25;
        else if (rand() > 0.96) value += 15 + rand() * 15;
      }

      value = clamp(value);

      data.push({
        timestamp: now - (perCategory - i) * intervalMs,
        value: Number(value.toFixed(2)),
        category,
        volume: Math.round(
          category === 'Network'
            ? value * 8 + rand() * 200
            : category === 'Disk I/O'
              ? value * 6 + rand() * 150
              : 200 + rand() * 800
        ),
      });
    }
  });

  data.sort((a, b) => a.timestamp - b.timestamp);
  return data;
}

export interface TypedSeries {
  timestamps: Float64Array;
  values: Float64Array;
}

/**
 * Splits a flat DataPoint[] into one typed-array pair per category.
 *
 * Two reasons this exists, not one:
 * 1. Correctness — all categories share the same timestamp range, so a
 *    single sorted-by-timestamp array interleaves unrelated series. Charting
 *    "All categories" from that flat array draws one line that jumps between
 *    CPU/Memory/Network/Disk values at almost every step. Each category needs
 *    its own series.
 * 2. Performance — Float64Array pairs are dramatically cheaper to move to a
 *    Web Worker than an array of {timestamp, value, category, volume} objects:
 *    no per-point object overhead, no repeated category strings, and typed
 *    arrays can be *transferred* (zero-copy) via postMessage's transfer list
 *    instead of structured-cloned.
 */
export function groupByCategoryTyped(data: DataPoint[]): Record<string, TypedSeries> {
  const counts: Record<string, number> = {};
  for (const p of data) counts[p.category] = (counts[p.category] ?? 0) + 1;

  const result: Record<string, TypedSeries> = {};
  const cursors: Record<string, number> = {};
  for (const cat of Object.keys(counts)) {
    result[cat] = {
      timestamps: new Float64Array(counts[cat]),
      values: new Float64Array(counts[cat]),
    };
    cursors[cat] = 0;
  }

  for (const p of data) {
    const i = cursors[p.category]++;
    result[p.category].timestamps[i] = p.timestamp;
    result[p.category].values[i] = p.value;
  }

  return result;
}
