export interface DataPoint {
  timestamp: number; // ms epoch
  value: number;
  category: string;
  volume: number;
}

export const CATEGORIES = ['CPU', 'Memory', 'Network', 'Disk I/O'];

/**
 * Generates a large synthetic time-series dataset using a random walk
 * so the data looks realistic (trends + noise) rather than pure random scatter.
 * Deterministic-ish via seeded PRNG so re-generating with same size is stable-ish.
 */
export function generateDataset(size: number): DataPoint[] {
  const data: DataPoint[] = [];
  const now = Date.now();
  const intervalMs = 1000; // 1 point per second per category

  let seed = 42;
  const rand = () => {
    // simple mulberry32 PRNG - fast, no external deps
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const perCategory = Math.ceil(size / CATEGORIES.length);

  CATEGORIES.forEach((category, catIdx) => {
    let value = 40 + catIdx * 5;
    for (let i = 0; i < perCategory; i++) {
      value += (rand() - 0.5) * 4;
      // add occasional spikes to simulate real system load
      if (rand() > 0.995) value += (rand() - 0.5) * 30;
      value = Math.max(0, Math.min(100, value));

      data.push({
        timestamp: now - (perCategory - i) * intervalMs,
        value: Number(value.toFixed(2)),
        category,
        volume: Math.round(rand() * 1000),
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
