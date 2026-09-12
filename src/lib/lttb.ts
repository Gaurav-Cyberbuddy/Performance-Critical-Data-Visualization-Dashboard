import type { DataPoint } from './dataGenerator';

/**
 * Largest-Triangle-Three-Buckets downsampling.
 *
 * Why this matters for the assignment: naively rendering 500k points on a
 * <canvas> (or worse, as SVG nodes) tanks frame rate and is visually useless
 * anyway, since a 1200px-wide chart can't show more than ~1200 distinct
 * x-positions. LTTB picks a representative subset of points per pixel-bucket
 * that preserves the visual shape of the line (peaks, valleys, spikes) far
 * better than naive stride-based sampling (every Nth point), which can hide
 * real anomalies/spikes entirely.
 *
 * Reference: Sveinn Steinarsson's 2013 thesis on time-series downsampling.
 */
export function lttbDownsample(data: DataPoint[], threshold: number): DataPoint[] {
  const n = data.length;
  if (threshold >= n || threshold <= 2) return data;

  const sampled: DataPoint[] = [];
  const bucketSize = (n - 2) / (threshold - 2);

  sampled.push(data[0]); // always keep first point

  let a = 0; // index of previously selected point

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

    // average point of NEXT bucket, used as the fixed third triangle vertex
    const nextStart = bucketEnd;
    const nextEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const avgRangeLength = Math.max(1, nextEnd - nextStart);
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += data[j] ? data[j].timestamp : data[n - 1].timestamp;
      avgY += data[j] ? data[j].value : data[n - 1].value;
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    const pointAX = data[a].timestamp;
    const pointAY = data[a].value;

    let maxArea = -1;
    let maxAreaIdx = bucketStart;

    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs(
        (pointAX - avgX) * (data[j].value - pointAY) -
          (pointAX - data[j].timestamp) * (avgY - pointAY)
      ) * 0.5;

      if (area > maxArea) {
        maxArea = area;
        maxAreaIdx = j;
      }
    }

    sampled.push(data[maxAreaIdx]);
    a = maxAreaIdx;
  }

  sampled.push(data[n - 1]); // always keep last point
  return sampled;
}

/**
 * Same LTTB algorithm as above, but operating on parallel typed arrays
 * instead of DataPoint objects — this is what actually gets sent to/from
 * the Web Worker (see dataWorker.ts). Avoids allocating an intermediate
 * object per point during the hot loop.
 */
export function lttbDownsampleTyped(
  timestamps: Float64Array,
  values: Float64Array,
  threshold: number
): { timestamps: Float64Array; values: Float64Array } {
  const n = timestamps.length;
  if (threshold >= n || threshold <= 2) {
    return { timestamps, values };
  }

  const outT = new Float64Array(threshold);
  const outV = new Float64Array(threshold);
  const bucketSize = (n - 2) / (threshold - 2);

  outT[0] = timestamps[0];
  outV[0] = values[0];

  let a = 0;
  let outIdx = 1;

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

    const nextStart = bucketEnd;
    const nextEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const avgRangeLength = Math.max(1, nextEnd - nextStart);
    for (let j = nextStart; j < nextEnd; j++) {
      const idx = j < n ? j : n - 1;
      avgX += timestamps[idx];
      avgY += values[idx];
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    const pointAX = timestamps[a];
    const pointAY = values[a];

    let maxArea = -1;
    let maxAreaIdx = bucketStart;

    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs(
        (pointAX - avgX) * (values[j] - pointAY) - (pointAX - timestamps[j]) * (avgY - pointAY)
      ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxAreaIdx = j;
      }
    }

    outT[outIdx] = timestamps[maxAreaIdx];
    outV[outIdx] = values[maxAreaIdx];
    outIdx++;
    a = maxAreaIdx;
  }

  outT[outIdx] = timestamps[n - 1];
  outV[outIdx] = values[n - 1];

  return { timestamps: outT, values: outV };
}
