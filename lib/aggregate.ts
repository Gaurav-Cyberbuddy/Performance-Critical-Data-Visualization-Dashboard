import type { DataPoint } from './dataGenerator';
import { CATEGORIES } from './dataGenerator';

export type AggregationBucket = 'none' | '1m' | '5m' | '1h';

export const AGGREGATION_MS: Record<Exclude<AggregationBucket, 'none'>, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
};

/**
 * Real time-bucket aggregation (mean value / volume per bucket).
 * This is NOT LTTB — LTTB is a visual downsampling step applied afterward
 * for chart rendering. Aggregation collapses points into fixed time windows.
 */
export function aggregateByBucket(
  data: DataPoint[],
  bucket: AggregationBucket
): DataPoint[] {
  if (bucket === 'none' || data.length === 0) return data;

  const bucketMs = AGGREGATION_MS[bucket];
  const out: DataPoint[] = [];

  for (const category of CATEGORIES) {
    const series = data.filter((p) => p.category === category);
    if (series.length === 0) continue;

    let bucketStart = Math.floor(series[0].timestamp / bucketMs) * bucketMs;
    let sumV = 0;
    let sumVol = 0;
    let count = 0;

    const flush = () => {
      if (count === 0) return;
      out.push({
        timestamp: bucketStart + bucketMs / 2,
        value: Number((sumV / count).toFixed(2)),
        category,
        volume: Math.round(sumVol / count),
      });
      sumV = 0;
      sumVol = 0;
      count = 0;
    };

    for (const p of series) {
      const b = Math.floor(p.timestamp / bucketMs) * bucketMs;
      if (b !== bucketStart) {
        flush();
        bucketStart = b;
      }
      sumV += p.value;
      sumVol += p.volume;
      count++;
    }
    flush();
  }

  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

export function aggregationLabel(bucket: AggregationBucket): string {
  switch (bucket) {
    case '1m':
      return '1 minute buckets (mean)';
    case '5m':
      return '5 minute buckets (mean)';
    case '1h':
      return '1 hour buckets (mean)';
    default:
      return 'None (raw points → LTTB only in Optimized mode)';
  }
}
