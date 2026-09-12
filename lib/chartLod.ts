/**
 * Canvas LOD helpers for Bar / Scatter / Heatmap.
 * Framework-independent. Line charts continue to use Worker + LTTB separately.
 */

export interface TypedXY {
  timestamps: Float64Array;
  values: Float64Array;
}

export interface BarBucket {
  tCenter: number;
  /** Mean value per series index; NaN if empty */
  means: Float64Array;
}

/** Aggregate each series into a fixed number of time buckets (mean). */
export function bucketSeriesForBars(
  series: TypedXY[],
  bucketCount: number,
  minT: number,
  maxT: number
): BarBucket[] {
  const nBuckets = Math.max(1, bucketCount);
  const span = maxT - minT || 1;
  const sums = series.map(() => new Float64Array(nBuckets));
  const counts = series.map(() => new Uint32Array(nBuckets));

  for (let s = 0; s < series.length; s++) {
    const { timestamps, values } = series[s];
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      if (t < minT || t > maxT) continue;
      let b = Math.floor(((t - minT) / span) * nBuckets);
      if (b >= nBuckets) b = nBuckets - 1;
      if (b < 0) b = 0;
      sums[s][b] += values[i];
      counts[s][b]++;
    }
  }

  const out: BarBucket[] = new Array(nBuckets);
  const bucketW = span / nBuckets;
  for (let b = 0; b < nBuckets; b++) {
    const means = new Float64Array(series.length);
    for (let s = 0; s < series.length; s++) {
      means[s] = counts[s][b] > 0 ? sums[s][b] / counts[s][b] : Number.NaN;
    }
    out[b] = { tCenter: minT + (b + 0.5) * bucketW, means };
  }
  return out;
}

/**
 * Stride / LOD downsample for scatter — keeps first & last, samples evenly.
 * Caps drawn points so Canvas never issues hundreds of thousands of fills.
 */
export function strideDownsample(
  timestamps: Float64Array,
  values: Float64Array,
  maxPoints: number
): TypedXY {
  const n = timestamps.length;
  if (n <= maxPoints) {
    return { timestamps, values };
  }
  const outT = new Float64Array(maxPoints);
  const outV = new Float64Array(maxPoints);
  outT[0] = timestamps[0];
  outV[0] = values[0];
  const inner = maxPoints - 2;
  for (let i = 0; i < inner; i++) {
    const idx = 1 + Math.floor((i / inner) * (n - 2));
    outT[i + 1] = timestamps[idx];
    outV[i + 1] = values[idx];
  }
  outT[maxPoints - 1] = timestamps[n - 1];
  outV[maxPoints - 1] = values[n - 1];
  return { timestamps: outT, values: outV };
}

export interface HeatmapGrid {
  cols: number;
  rows: number;
  /** Row-major counts, length cols * rows (row 0 = highest value bin) */
  counts: Uint32Array;
  maxCount: number;
  minT: number;
  maxT: number;
  minV: number;
  maxV: number;
}

/** Build a real 2D time×value density histogram from typed series. */
export function buildHeatmapGrid(
  series: TypedXY[],
  cols: number,
  rows: number,
  minT: number,
  maxT: number,
  minV: number,
  maxV: number
): HeatmapGrid {
  const counts = new Uint32Array(cols * rows);
  const tSpan = maxT - minT || 1;
  const vSpan = maxV - minV || 1;
  let maxCount = 0;

  for (const s of series) {
    for (let i = 0; i < s.timestamps.length; i++) {
      const t = s.timestamps[i];
      const v = s.values[i];
      if (t < minT || t > maxT) continue;
      let c = Math.floor(((t - minT) / tSpan) * cols);
      let r = Math.floor(((v - minV) / vSpan) * rows);
      if (c >= cols) c = cols - 1;
      if (r >= rows) r = rows - 1;
      if (c < 0) c = 0;
      if (r < 0) r = 0;
      // Flip vertically so high values sit at the top of the canvas
      const rowFromTop = rows - 1 - r;
      const idx = rowFromTop * cols + c;
      const next = counts[idx] + 1;
      counts[idx] = next;
      if (next > maxCount) maxCount = next;
    }
  }

  return { cols, rows, counts, maxCount, minT, maxT, minV, maxV };
}

/** Simple density → color (dark navy → cyan → yellow). */
export function heatmapColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.5) {
    const u = x / 0.5;
    const r = Math.round(16 + u * (79 - 16));
    const g = Math.round(19 + u * (125 - 19));
    const b = Math.round(28 + u * (245 - 28));
    return `rgb(${r},${g},${b})`;
  }
  const u = (x - 0.5) / 0.5;
  const r = Math.round(79 + u * (234 - 79));
  const g = Math.round(125 + u * (179 - 125));
  const b = Math.round(245 + u * (8 - 245));
  return `rgb(${r},${g},${b})`;
}
