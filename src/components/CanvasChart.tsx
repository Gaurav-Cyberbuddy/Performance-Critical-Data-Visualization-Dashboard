import { useEffect, useRef, useCallback, useState } from 'react';

export interface ChartSeries {
  name: string;
  color: string;
  timestamps: Float64Array;
  values: Float64Array;
}

interface Props {
  series: ChartSeries[];
  label: string;
  onRender?: (durationMs: number, totalPointCount: number) => void;
}

// Rendering directly to Canvas2D instead of SVG or a chart library is the
// key perf decision here: SVG creates one DOM node per data point (garbage
// collector + layout thrash at scale), while Canvas is a single bitmap the
// GPU composites once. Each series is one stroke() call, so drawing 4 series
// is still only 4 draw calls regardless of how many points feed into them.
export function CanvasChart({ series, label, onRender }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    timestamp: number;
    readings: { name: string; color: string; value: number }[];
  } | null>(null);
  const [renderMs, setRenderMs] = useState(0);
  const dims = useRef({ width: 800, height: 300 });

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
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const padding = 30;

    // Global bounds across all series — loop-based, not spread-based, so
    // this doesn't overflow the call stack on large (Raw mode) arrays.
    let minT = Infinity;
    let maxT = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const s of series) {
      const n = s.timestamps.length;
      if (n === 0) continue;
      if (s.timestamps[0] < minT) minT = s.timestamps[0];
      if (s.timestamps[n - 1] > maxT) maxT = s.timestamps[n - 1];
      for (let i = 0; i < n; i++) {
        if (s.values[i] < minV) minV = s.values[i];
        if (s.values[i] > maxV) maxV = s.values[i];
      }
    }

    const xScale = (t: number) =>
      padding + ((t - minT) / (maxT - minT || 1)) * (width - padding * 2);
    const yScale = (v: number) =>
      height - padding - ((v - minV) / (maxV - minV || 1)) * (height - padding * 2);

    // grid
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding + (i * (height - padding * 2)) / 4;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(width - padding, y);
      ctx.stroke();
    }

    // one stroke() call per series — each category gets its own uninterrupted line
    for (const s of series) {
      const n = s.timestamps.length;
      if (n === 0) continue;
      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < n; i++) {
        const x = xScale(s.timestamps[i]);
        const y = yScale(s.values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = '#6b7280';
    ctx.font = '11px sans-serif';
    ctx.fillText(maxV.toFixed(1), 2, padding);
    ctx.fillText(minV.toFixed(1), 2, height - padding);

    const duration = performance.now() - t0;
    setRenderMs(duration);
    onRender?.(duration, totalPoints);
  }, [series, totalPoints, onRender]);

  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      dims.current = { width: Math.max(300, width), height: 300 };
      draw();
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (series.length === 0) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { width } = dims.current;
    const padding = 30;

    let minT = Infinity;
    let maxT = -Infinity;
    for (const s of series) {
      const n = s.timestamps.length;
      if (n === 0) continue;
      if (s.timestamps[0] < minT) minT = s.timestamps[0];
      if (s.timestamps[n - 1] > maxT) maxT = s.timestamps[n - 1];
    }
    const ratio = (x - padding) / (width - padding * 2);
    const targetT = minT + ratio * (maxT - minT);

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

  return (
    <div ref={containerRef} className="chart-container">
      <div className="chart-header">
        <span className="chart-label">{label}</span>
        <span className="chart-meta">
          {totalPoints.toLocaleString()} pts rendered · {renderMs.toFixed(2)}ms
        </span>
      </div>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      />
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.name} className="legend-item">
              <span className="legend-dot" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {hover && (
        <div className="tooltip" style={{ left: hover.x + 12, top: hover.y }}>
          <div className="tooltip-time">{new Date(hover.timestamp).toLocaleTimeString()}</div>
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
