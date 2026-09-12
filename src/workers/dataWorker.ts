import { lttbDownsampleTyped } from '../lib/lttb';

export interface TypedDownsampleRequest {
  type: 'DOWNSAMPLE_TYPED';
  category: string;
  timestamps: Float64Array;
  values: Float64Array;
  threshold: number;
}

export interface TypedAggregateRequest {
  type: 'AGGREGATE_TYPED';
  category: string;
  values: Float64Array;
}

export type WorkerRequest = TypedDownsampleRequest | TypedAggregateRequest;

export interface DownsampleResult {
  type: 'DOWNSAMPLE_RESULT';
  category: string;
  timestamps: Float64Array;
  values: Float64Array;
  durationMs: number;
}

export interface AggregateResult {
  type: 'AGGREGATE_RESULT';
  category: string;
  stats: { min: number; max: number; avg: number; count: number };
  durationMs: number;
}

export type WorkerResponse = DownsampleResult | AggregateResult;

// Both requests and responses here move Float64Arrays via postMessage's
// transfer list (the array passed as the second argument), not structured
// clone. That means each hop is an O(1) pointer handoff instead of a copy of
// every element — the previous version sent the full DataPoint[] (with a
// repeated category string and volume field per point) and cloned it on
// every request, which is exactly the overhead this avoids.
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const start = performance.now();
  const req = e.data;

  if (req.type === 'DOWNSAMPLE_TYPED') {
    const { timestamps, values } = lttbDownsampleTyped(req.timestamps, req.values, req.threshold);
    const response: DownsampleResult = {
      type: 'DOWNSAMPLE_RESULT',
      category: req.category,
      timestamps,
      values,
      durationMs: performance.now() - start,
    };
    (self as unknown as Worker).postMessage(response, [timestamps.buffer, values.buffer]);
  } else if (req.type === 'AGGREGATE_TYPED') {
    const { values } = req;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const response: AggregateResult = {
      type: 'AGGREGATE_RESULT',
      category: req.category,
      stats: { min, max, avg: sum / (values.length || 1), count: values.length },
      durationMs: performance.now() - start,
    };
    (self as unknown as Worker).postMessage(response);
  }
};
