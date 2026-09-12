'use client';

import {
  useEffect,
  useRef,
  useCallback,
  useState,
  type WheelEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  bucketSeriesForBars,
  strideDownsample,
  buildHeatmapGrid,
  heatmapColor,
} from '@/lib/chartLod';

export type ChartType = 'line' | 'bar' | 'scatter' | 'heatmap';

export interface ChartSeries {
  name: string;
  color: string;
  timestamps: Float64Array;
  values: Float64Array;
}

interface Props {
  series: ChartSeries[];
  label: string;
  chartType?: ChartType;
  measureMode: 'raw' | 'optimized';
  measureConfigKey: string;
  onRender?: (
    durationMs: number,
    totalPointCount: number,
    measureMode: 'raw' | 'optimized',
    measureConfigKey: string
  ) => void;
}

interface ViewWindow {
  start: number;
  end: number;
}

const PAD = { top: 16, right: 16, bottom: 36, left: 44 };
const SCATTER_MAX_PER_SERIES = 2500;
const BAR_BUCKETS = 64;
const HEATMAP_COLS = 96;
const HEATMAP_ROWS = 40;

function fullDomain(series: ChartSeries[]): { minT: number; maxT: number; maxV: number } {
  let minT = Infinity;
  let maxT = -Infinity;
  let maxV = -Infinity;
  for (const s of series) {
    const n = s.timestamps.length;
    if (n === 0) continue;
    if (s.timestamps[0] < minT) minT = s.timestamps[0];
    if (s.timestamps[n - 1] > maxT) maxT = s.timestamps[n - 1];
    for (let i = 0; i < n; i++) {
      if (s.values[i] > maxV) maxV = s.values[i];
    }
  }
  return { minT, maxT, maxV };
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  minT: number,
  maxT: number,
  yMin: number,
  yMax: number,
  xScale: (t: number) => number,
  yScale: (v: number) => number
) {
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + ((yMax - yMin) * i) / yTicks;
    const y = yScale(val);
    ctx.strokeStyle = '#1f2430';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(width - PAD.right, y);
    ctx.stroke();
    ctx.fillStyle = '#6b7280';
    ctx.fillText(val.toFixed(0), PAD.left - 8, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const t = minT + ((maxT - minT) * i) / xTicks;
    const x = xScale(t);
    ctx.strokeStyle = '#1a1e28';
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, height - PAD.bottom);
    ctx.stroke();
    ctx.fillStyle = '#6b7280';
    ctx.fillText(
      new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      x,
      height - PAD.bottom + 8
    );
  }

  ctx.strokeStyle = '#2a2f3a';
  ctx.strokeRect(PAD.left, PAD.top, plotW, plotH);
}

// Rendering directly to Canvas2D instead of SVG or a chart library is the
// key perf decision here. Line mode still uses one stroke() per series.
// Bar / Scatter / Heatmap apply LOD / binning so 500K inputs never become
// hundreds of thousands of Canvas primitives.
export function CanvasChart({
  series,
  label,
  chartType = 'line',
  measureMode,
  measureConfigKey,
  onRender,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    timestamp: number;
    readings: { name: string; color: string; value: number }[];
  } | null>(null);
  const [renderMs, setRenderMs] = useState(0);
  const [drawnMeta, setDrawnMeta] = useState('');
  const [view, setView] = useState<ViewWindow>({ start: 0, end: 1 });
  const dims = useRef({ width: 800, height: 340 });
  const viewRef = useRef(view);
  const dragRef = useRef<{ x: number; start: number; end: number } | null>(null);
  const domainRef = useRef({ minT: 0, maxT: 1 });

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const totalPoints = series.reduce((sum, s) => sum + s.values.length, 0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || series.length === 0 || totalPoints === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const t0 = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = dims.current;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { minT: dataMinT, maxT: dataMaxT, maxV } = fullDomain(series);
    if (!Number.isFinite(dataMinT) || !Number.isFinite(dataMaxT) || dataMaxT <= dataMinT) return;

    domainRef.current = { minT: dataMinT, maxT: dataMaxT };
    const span = dataMaxT - dataMinT;
    const v = viewRef.current;
    const minT = dataMinT + v.start * span;
    const maxT = dataMinT + v.end * span;

    const yMin = 0;
    const yMax = Math.max(100, Math.ceil(maxV / 10) * 10);
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;

    const xScale = (t: number) => PAD.left + ((t - minT) / (maxT - minT || 1)) * plotW;
    const yScale = (val: number) => PAD.top + plotH - ((val - yMin) / (yMax - yMin || 1)) * plotH;

    drawAxes(ctx, width, height, minT, maxT, yMin, yMax, xScale, yScale);

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotW, plotH);
    ctx.clip();

    let meta = '';

    if (chartType === 'line') {
      // Existing optimized path: one stroke() per series (LTTB already applied upstream in Optimized mode).
      for (const s of series) {
        const n = s.timestamps.length;
        if (n === 0) continue;
        ctx.beginPath();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.75;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        let started = false;
        for (let i = 0; i < n; i++) {
          const t = s.timestamps[i];
          if (t < minT) {
            if (i + 1 < n && s.timestamps[i + 1] >= minT) {
              /* fall through to start near edge */
            } else {
              continue;
            }
          }
          if (t > maxT) break;
          const x = xScale(t);
          const y = yScale(s.values[i]);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        if (started) ctx.stroke();
      }
      meta = `${totalPoints.toLocaleString('en-US')} pts · line`;
    } else if (chartType === 'bar') {
      const typed = series.map((s) => ({ timestamps: s.timestamps, values: s.values }));
      const buckets = bucketSeriesForBars(typed, BAR_BUCKETS, minT, maxT);
      const seriesCount = Math.max(1, series.length);
      const groupW = plotW / buckets.length;
      const barW = Math.max(1, (groupW * 0.75) / seriesCount);

      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        const groupLeft = PAD.left + b * groupW + groupW * 0.125;
        for (let s = 0; s < series.length; s++) {
          const mean = bucket.means[s];
          if (!Number.isFinite(mean)) continue;
          const x = groupLeft + s * barW;
          const y = yScale(mean);
          const h = PAD.top + plotH - y;
          ctx.fillStyle = series[s].color;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x, y, Math.max(1, barW - 1), Math.max(1, h));
        }
      }
      ctx.globalAlpha = 1;
      meta = `${buckets.length} time buckets · bar (mean)`;
    } else if (chartType === 'scatter') {
      let drawn = 0;
      for (const s of series) {
        const lod = strideDownsample(s.timestamps, s.values, SCATTER_MAX_PER_SERIES);
        ctx.fillStyle = s.color;
        for (let i = 0; i < lod.timestamps.length; i++) {
          const t = lod.timestamps[i];
          if (t < minT || t > maxT) continue;
          const x = xScale(t);
          const y = yScale(lod.values[i]);
          ctx.fillRect(x - 1.25, y - 1.25, 2.5, 2.5);
          drawn++;
        }
      }
      meta = `${drawn.toLocaleString('en-US')} markers · scatter LOD`;
    } else {
      // Heatmap: real time × value density bins (not a recolored line).
      const typed = series.map((s) => ({ timestamps: s.timestamps, values: s.values }));
      const grid = buildHeatmapGrid(typed, HEATMAP_COLS, HEATMAP_ROWS, minT, maxT, yMin, yMax);
      const cellW = plotW / grid.cols;
      const cellH = plotH / grid.rows;
      const maxC = Math.max(1, grid.maxCount);
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          const count = grid.counts[r * grid.cols + c];
          if (count === 0) continue;
          ctx.fillStyle = heatmapColor(count / maxC);
          ctx.fillRect(PAD.left + c * cellW, PAD.top + r * cellH, cellW + 0.5, cellH + 0.5);
        }
      }
      meta = `${grid.cols}×${grid.rows} bins · heatmap density`;
    }

    ctx.restore();

    const duration = performance.now() - t0;
    setRenderMs(duration);
    setDrawnMeta(meta);
    onRender?.(duration, totalPoints, measureMode, measureConfigKey);
  }, [series, totalPoints, measureMode, measureConfigKey, onRender, view, chartType]);

  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      dims.current = { width: Math.max(300, width), height: 340 };
      draw();
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    setView({ start: 0, end: 1 });
  }, [measureConfigKey, chartType]);

  const clientToFraction = (clientX: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const plotW = dims.current.width - PAD.left - PAD.right;
    return Math.max(0, Math.min(1, (x - PAD.left) / plotW));
  };

  const handleWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const frac = clientToFraction(e.clientX);
    const cur = viewRef.current;
    const span = cur.end - cur.start;
    const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const newSpan = Math.min(1, Math.max(0.02, span * zoomFactor));
    let start = cur.start + (span - newSpan) * frac;
    let end = start + newSpan;
    if (start < 0) {
      start = 0;
      end = newSpan;
    }
    if (end > 1) {
      end = 1;
      start = 1 - newSpan;
    }
    setView({ start, end });
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, start: viewRef.current.start, end: viewRef.current.end };
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const plotW = dims.current.width - PAD.left - PAD.right;
      const span = drag.end - drag.start;
      const dx = e.clientX - drag.x;
      const dFrac = -(dx / plotW) * span;
      let start = drag.start + dFrac;
      let end = drag.end + dFrac;
      if (start < 0) {
        start = 0;
        end = span;
      }
      if (end > 1) {
        end = 1;
        start = 1 - span;
      }
      setView({ start, end });
      return;
    }

    if (series.length === 0 || chartType === 'heatmap') {
      setHover(null);
      return;
    }

    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { minT: dataMinT, maxT: dataMaxT } = domainRef.current;
    const span = dataMaxT - dataMinT;
    const cur = viewRef.current;
    const minT = dataMinT + cur.start * span;
    const maxT = dataMinT + cur.end * span;
    const plotW = dims.current.width - PAD.left - PAD.right;
    const ratio = (x - PAD.left) / plotW;
    const targetT = minT + Math.max(0, Math.min(1, ratio)) * (maxT - minT);

    const readings: { name: string; color: string; value: number }[] = [];
    for (const s of series) {
      const n = s.timestamps.length;
      if (n === 0) continue;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.timestamps[mid] < targetT) lo = mid + 1;
        else hi = mid;
      }
      readings.push({ name: s.name, color: s.color, value: s.values[lo] });
    }

    setHover({ x, y: e.clientY - rect.top, timestamp: targetT, readings });
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const zoomed = view.start > 0.001 || view.end < 0.999;

  return (
    <div ref={containerRef} className="chart-container">
      <div className="chart-header">
        <span className="chart-label">{label}</span>
        <span className="chart-meta">
          {drawnMeta || `${totalPoints.toLocaleString('en-US')} pts`} · {renderMs.toFixed(2)} ms
          {zoomed ? ' · zoomed' : ''}
          {' · scroll=zoom · drag=pan'}
        </span>
        {zoomed && (
          <button type="button" className="chart-reset-btn" onClick={() => setView({ start: 0, end: 1 })}>
            Reset view
          </button>
        )}
      </div>
      <canvas
        ref={canvasRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onMouseLeave={() => {
          if (!dragRef.current) setHover(null);
        }}
        style={{ cursor: dragRef.current ? 'grabbing' : 'crosshair', touchAction: 'none' }}
      />
      {series.length > 0 && chartType !== 'heatmap' && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.name} className="legend-item">
              <span className="legend-dot" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {chartType === 'heatmap' && (
        <div className="chart-legend">
          <span className="legend-item">Heatmap density (time × value bins)</span>
          <span className="legend-item">
            <span className="legend-dot" style={{ background: heatmapColor(0.2) }} /> low
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ background: heatmapColor(0.55) }} /> mid
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ background: heatmapColor(1) }} /> high
          </span>
        </div>
      )}
      {hover && !dragRef.current && (
        <div className="tooltip" style={{ left: hover.x + 12, top: hover.y }}>
          <div className="tooltip-time">{new Date(hover.timestamp).toLocaleTimeString('en-US')}</div>
          {hover.readings.map((r) => (
            <div key={r.name}>
              <span className="legend-dot" style={{ background: r.color }} /> {r.name}: {r.value.toFixed(1)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
