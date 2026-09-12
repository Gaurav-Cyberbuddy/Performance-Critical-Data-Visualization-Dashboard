'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { generateDataset, groupByCategoryTyped, CATEGORIES, type DataPoint, type Category } from '@/lib/dataGenerator';
import { aggregateByBucket, aggregationLabel, type AggregationBucket } from '@/lib/aggregate';
import { appendStreamTick, filterByTimeRange, type TimeRangeKey } from '@/lib/stream';
import { CanvasChart, type ChartSeries, type ChartType } from '@/components/CanvasChart';
import { VirtualTable } from '@/components/VirtualTable';
import { PerfHUD } from '@/components/PerfHUD';
import type { WorkerResponse } from '@/workers/dataWorker';

const SIZE_OPTIONS = [10_000, 50_000, 100_000, 250_000, 500_000];
const STRESS_SIZES = [10_000, 50_000, 100_000, 500_000] as const;
const CATEGORY_COLORS: Record<string, string> = {
  CPU: '#6366f1',
  Memory: '#22c55e',
  Network: '#f59e0b',
  'Disk I/O': '#ec4899',
};
const RAW_WARNING_THRESHOLD = 100_000;
const DEFAULT_VISIBLE: Record<Category, boolean> = {
  CPU: true,
  Memory: true,
  Network: false,
  'Disk I/O': false,
};

function formatPoints(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString('en-US');
}

export function Dashboard() {
  const [datasetSize, setDatasetSize] = useState(500_000);
  const [rawData, setRawData] = useState<DataPoint[]>([]);
  const [visibleSeries, setVisibleSeries] = useState(DEFAULT_VISIBLE);
  const [tableCategory, setTableCategory] = useState<string>('All');
  const [genMs, setGenMs] = useState(0);
  const [workerMsByCategory, setWorkerMsByCategory] = useState<Record<string, number>>({});
  const [downsampledByCategory, setDownsampledByCategory] = useState<Record<string, ChartSeries>>({});
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'raw' | 'optimized'>('optimized');
  // Benchmark timings live only in React memory for this page load — never
  // written to localStorage/sessionStorage. A refresh starts a clean session.
  const [benchmark, setBenchmark] = useState<{
    configKey: string;
    raw: { ms: number; points: number } | null;
    optimized: { ms: number; points: number } | null;
  }>({ configKey: '0|', raw: null, optimized: null });
  const [datasetEpoch, setDatasetEpoch] = useState(0);
  const [liveFps, setLiveFps] = useState(0);
  // Per-mode FPS samples taken while that mode's chart is on screen.
  // Independent of the top-right live/display FPS indicator.
  const [modeFps, setModeFps] = useState<{
    configKey: string;
    raw: number | null;
    optimized: number | null;
  }>({ configKey: '0|', raw: null, optimized: null });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('all');
  const [aggregation, setAggregation] = useState<AggregationBucket>('none');
  const [heapLabel, setHeapLabel] = useState<string>('—');
  const [chartType, setChartType] = useState<ChartType>('line');
  const workerRef = useRef<Worker | null>(null);
  const workerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Next.js / webpack 5: construct workers from a module URL so the worker
    // chunk is emitted correctly in production builds.
    workerRef.current = new Worker(new URL('../workers/dataWorker.ts', import.meta.url));
    workerRef.current.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const res = e.data;
      if (res.type === 'DOWNSAMPLE_RESULT') {
        setDownsampledByCategory((prev) => ({
          ...prev,
          [res.category]: {
            name: res.category,
            color: CATEGORY_COLORS[res.category] ?? '#6366f1',
            timestamps: res.timestamps,
            values: res.values,
          },
        }));
        setWorkerMsByCategory((prev) => ({ ...prev, [res.category]: res.durationMs }));
      }
    };
    workerRef.current.onerror = () => {
      setError('Web Worker failed. Try regenerating the dataset.');
    };
    return () => workerRef.current?.terminate();
  }, []);

  const regenerate = useCallback((size: number) => {
    setError(null);
    setStreaming(false);
    setGenerating(true);
    // Yield so the loading state paints before the sync generation blocks.
    const raf = requestAnimationFrame(() => {
      try {
        const t0 = performance.now();
        const data = generateDataset(size);
        setGenMs(performance.now() - t0);
        setDatasetEpoch((epoch) => epoch + 1);
        setRawData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to generate dataset');
      } finally {
        setGenerating(false);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    // Cancel stale rAF work on re-run / Strict Mode remount so a late
    // setRawData cannot wipe comparison measurements after the user has
    // already measured Raw or Optimized.
    return regenerate(datasetSize);
  }, [datasetSize, regenerate]);

  // Simulated live stream: append one sample per category every 100ms.
  // Only 4 lightweight points are created per tick; oldest rows are trimmed
  // to datasetSize so the main thread is not blocked by full regeneration.
  useEffect(() => {
    if (!streaming || generating || rawData.length === 0) return;
    const id = window.setInterval(() => {
      setRawData((prev) => appendStreamTick(prev, datasetSize));
    }, 100);
    return () => clearInterval(id);
  }, [streaming, generating, datasetSize, rawData.length]);

  // Genuine browser-reported JS heap (Chrome/Edge performance.memory only).
  useEffect(() => {
    const readHeap = () => {
      const perf = performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      if (!perf.memory) {
        setHeapLabel('Unavailable');
        return;
      }
      const used = perf.memory.usedJSHeapSize / (1024 * 1024);
      const limit = perf.memory.jsHeapSizeLimit / (1024 * 1024);
      setHeapLabel(`${used.toFixed(1)} MB used · ${limit.toFixed(0)} MB limit`);
    };
    readHeap();
    const id = window.setInterval(readHeap, 1000);
    return () => clearInterval(id);
  }, []);

  // Time-range filter → optional bucket aggregation → typed arrays.
  // Aggregation is distinct from LTTB (applied later in the worker for Optimized).
  const rangedData = useMemo(() => filterByTimeRange(rawData, timeRange), [rawData, timeRange]);
  const workingData = useMemo(
    () => aggregateByBucket(rangedData, aggregation),
    [rangedData, aggregation]
  );

  // Grouped once per working dataset — one Float64Array pair per category.
  const typedByCategory = useMemo(() => groupByCategoryTyped(workingData), [workingData]);

  const activeCategories = useMemo(
    () => CATEGORIES.filter((c) => visibleSeries[c]),
    [visibleSeries]
  );

  // Stable key for selected series — used so mode toggles never look like a
  // config change and accidentally clear Raw/Optimized timings.
  const selectedSeriesKey = activeCategories.join('|');
  // Epoch bumps only on regenerate/size load; series/range/agg bumps clear timings.
  // Live stream ticks do not change this key.
  const benchmarkConfigKey = `${datasetEpoch}|${selectedSeriesKey}|${timeRange}|${aggregation}|${chartType}`;

  // Reset the in-memory benchmark session when dataset/series config changes.
  // Done during render so we never clear *after* a child draw has recorded.
  // Mode switches do not change benchmarkConfigKey, so timings persist.
  if (benchmark.configKey !== benchmarkConfigKey) {
    setBenchmark({ configKey: benchmarkConfigKey, raw: null, optimized: null });
  }
  if (modeFps.configKey !== benchmarkConfigKey) {
    setModeFps({ configKey: benchmarkConfigKey, raw: null, optimized: null });
  }

  const rawMeasured = benchmark.raw;
  const optimizedMeasured = benchmark.optimized;
  const rawMeasuredFps = modeFps.raw;
  const optimizedMeasuredFps = modeFps.optimized;

  // Clear stale worker outputs when the base config changes (not every stream tick).
  useEffect(() => {
    setDownsampledByCategory({});
    setWorkerMsByCategory({});
  }, [datasetEpoch, timeRange, aggregation]);

  useEffect(() => {
    if (workingData.length === 0 || !workerRef.current) return;

    const postDownsample = () => {
      if (!workerRef.current) return;
      // Always downsample all categories so toggling series is instant.
      const seriesCount = Math.max(1, activeCategories.length);
      const perSeriesThreshold = seriesCount >= 3 ? 400 : seriesCount === 2 ? 800 : 1200;

      for (const cat of CATEGORIES) {
        const src = typedByCategory[cat];
        if (!src) continue;
        const timestamps = src.timestamps.slice();
        const values = src.values.slice();
        workerRef.current.postMessage(
          { type: 'DOWNSAMPLE_TYPED', category: cat, timestamps, values, threshold: perSeriesThreshold },
          [timestamps.buffer, values.buffer]
        );
      }
    };

    // While streaming, debounce worker posts so 100ms ticks don't flood the main thread.
    if (streaming) {
      if (workerDebounceRef.current) clearTimeout(workerDebounceRef.current);
      workerDebounceRef.current = setTimeout(postDownsample, 400);
      return () => {
        if (workerDebounceRef.current) clearTimeout(workerDebounceRef.current);
      };
    }

    postDownsample();
  }, [workingData, typedByCategory, activeCategories.length, streaming]);

  const filteredRawData = useMemo(() => {
    let d = tableCategory === 'All' ? workingData : workingData.filter((p) => p.category === tableCategory);
    if (search.trim()) {
      const term = search.toLowerCase();
      d = d.filter((p) => p.category.toLowerCase().includes(term));
    }
    return d;
  }, [workingData, tableCategory, search]);

  const latestByCategory = useMemo(() => {
    const result: Record<string, DataPoint> = {};
    for (const p of rawData) {
      result[p.category] = p;
    }
    return result;
  }, [rawData]);

  const optimizedSeries = useMemo(() => {
    const series: ChartSeries[] = [];
    for (const cat of activeCategories) {
      const s = downsampledByCategory[cat];
      if (s) series.push(s);
    }
    return series;
  }, [activeCategories, downsampledByCategory]);

  const rawSeries = useMemo(() => {
    const series: ChartSeries[] = [];
    for (const cat of activeCategories) {
      const src = typedByCategory[cat];
      if (!src) continue;
      series.push({
        name: cat,
        color: CATEGORY_COLORS[cat] ?? '#6366f1',
        timestamps: src.timestamps,
        values: src.values,
      });
    }
    return series;
  }, [activeCategories, typedByCategory]);

  const chartSeries = mode === 'raw' ? rawSeries : optimizedSeries;
  const selectedRawPoints = rawSeries.reduce((sum, s) => sum + s.values.length, 0);
  const selectedOptimizedPoints = optimizedSeries.reduce((sum, s) => sum + s.values.length, 0);
  const renderedPoints = mode === 'raw' ? selectedRawPoints : selectedOptimizedPoints;

  // Full-dataset optimized total (all four metrics), independent of series toggles.
  // Uses current working (range + aggregation) set so overview stays consistent.
  let overallOptimizedPoints = 0;
  let overallDownsampleReady = true;
  for (const cat of CATEGORIES) {
    const s = downsampledByCategory[cat];
    if (!s) {
      overallDownsampleReady = false;
      overallOptimizedPoints = 0;
      break;
    }
    overallOptimizedPoints += s.values.length;
  }

  const workingPointCount = workingData.length;

  const workerMs = useMemo(() => {
    const times = activeCategories.map((c) => workerMsByCategory[c]).filter((t) => t != null);
    if (times.length === 0) return 0;
    return times.reduce((a, b) => a + b, 0);
  }, [activeCategories, workerMsByCategory]);

  const overallReductionPct =
    workingPointCount > 0 && overallDownsampleReady && overallOptimizedPoints > 0
      ? (1 - overallOptimizedPoints / workingPointCount) * 100
      : null;

  const selectedReductionPct =
    selectedRawPoints > 0 && selectedOptimizedPoints > 0
      ? (1 - selectedOptimizedPoints / selectedRawPoints) * 100
      : null;

  // Backward-compatible alias used only where "current chart reduction" is meant.
  const reductionPct = mode === 'optimized' ? selectedReductionPct : null;

  // Record at most one timing per mode for the current benchmark session.
  // Later redraws (resize, Strict Mode re-run, mode toggles) must not erase
  // the sibling mode or replace an already captured sample for this config.
  const handleChartRender = useCallback(
    (
      durationMs: number,
      pointCount: number,
      measureMode: 'raw' | 'optimized',
      drawConfigKey: string
    ) => {
      setBenchmark((prev) => {
        // Ignore draws that belong to a stale config (e.g. in-flight after regenerate).
        if (prev.configKey !== drawConfigKey) return prev;

        if (measureMode === 'raw') {
          if (prev.raw) return prev;
          return { ...prev, raw: { ms: durationMs, points: pointCount } };
        }

        if (prev.optimized) return prev;
        return { ...prev, optimized: { ms: durationMs, points: pointCount } };
      });
    },
    []
  );

  const toggleSeries = (cat: Category) => {
    setVisibleSeries((prev) => {
      const next = { ...prev, [cat]: !prev[cat] };
      // Keep at least one series visible
      if (!CATEGORIES.some((c) => next[c])) return prev;
      return next;
    });
  };

  const chartReady =
    !generating &&
    (mode === 'raw'
      ? rawSeries.length > 0
      : optimizedSeries.length === activeCategories.length && activeCategories.length > 0);
  const selectedSeriesLabel = activeCategories.join(' + ') || 'None';
  const chartLabel =
    mode === 'raw'
      ? `${selectedSeriesLabel} — ${chartType} · Raw · range ${timeRange} · agg ${aggregation}`
      : `${selectedSeriesLabel} — ${chartType} · Optimized (agg → LTTB · Worker · Canvas) · range ${timeRange}`;

  // Sample rAF FPS only while the active mode's chart is actually mounted/rendering.
  // Store one genuine sample per mode per config; never copy the HUD liveFps value.
  useEffect(() => {
    if (!chartReady) return;
    if (mode === 'raw' && rawMeasuredFps != null) return;
    if (mode === 'optimized' && optimizedMeasuredFps != null) return;

    let frames = 0;
    let lastTime = performance.now();
    let raf = 0;
    let finished = false;

    const tick = () => {
      frames++;
      const now = performance.now();
      if (!finished && now - lastTime >= 500) {
        const sample = Math.round((frames * 1000) / (now - lastTime));
        if (sample > 0) {
          finished = true;
          setModeFps((prev) => {
            if (prev.configKey !== benchmarkConfigKey) return prev;
            if (mode === 'raw') {
              if (prev.raw != null) return prev;
              return { ...prev, raw: sample };
            }
            if (prev.optimized != null) return prev;
            return { ...prev, optimized: sample };
          });
          return;
        }
        frames = 0;
        lastTime = now;
      }
      if (!finished) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [chartReady, mode, benchmarkConfigKey, rawMeasuredFps, optimizedMeasuredFps]);

  return (
    <div className="dashboard-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4f7df5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div className="sidebar-title">Time-Series Visualizer</div>
          <div className="sidebar-subtitle">Web Workers &amp; LTTB</div>
        </div>
        <nav className="sidebar-nav">
          <div className="sidebar-nav-item active">
            <span className="sidebar-nav-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            </span>
            Dashboard
          </div>
        </nav>
        <div className="sidebar-badge">⚡ Built for Performance</div>
      </aside>
  
      {/* Main content area */}
      <div className="main-area">
        {/* Top header */}
        <header className="top-header">
          <div className="top-header-title">Performance Dashboard</div>
          <div className="top-header-right">
            <span
              className="heap-hud"
              title="Browser-reported JS heap via performance.memory (Chrome/Edge). Not available in all browsers."
            >
              JS heap: {heapLabel}
            </span>
            <PerfHUD onFps={setLiveFps} />
          </div>
        </header>
  
        {/* Dashboard content */}
        <div className="app">
          {error && (
            <div className="state-banner state-error" role="alert">
              {error}
              <button type="button" onClick={() => regenerate(datasetSize)}>
                Retry
              </button>
            </div>
          )}
  
          {/* Dataset overview cards */}
          <div className="dashboard-card">
            <div className="dashboard-card-title">📊 Dataset Overview</div>
            <div className="dashboard-card-subtitle">Overall dataset vs selected series reduction analysis</div>
            <section className="reduction-panels" aria-label="Dataset vs selected series reduction">
              {/* KEEP the exact same two reduction-panel divs with ALL the same JSX inside */}
              <div className="reduction-panel">
                <div className="reduction-panel-title">Overall dataset</div>
                <p className="reduction-panel-desc">
                  All four metrics in memory — independent of which series are plotted.
                </p>
                <div className="hero-metrics nested">
                  <div className="hero-metric">
                    <span className="hero-label">Working points</span>
                    <span className="hero-value">{workingPointCount ? formatPoints(workingPointCount) : '—'}</span>
                    <span className="hero-sub">
                      {workingPointCount
                        ? `${workingPointCount.toLocaleString('en-US')} after range/agg · buffer ${rawData.length.toLocaleString('en-US')}`
                        : '—'}
                    </span>
                  </div>
                  <div className="hero-arrow" aria-hidden>→</div>
                  <div className="hero-metric">
                    <span className="hero-label">After LTTB</span>
                    <span className="hero-value">
                      {overallDownsampleReady && overallOptimizedPoints > 0
                        ? formatPoints(overallOptimizedPoints)
                        : '—'}
                    </span>
                    <span className="hero-sub">
                      {overallDownsampleReady && overallOptimizedPoints > 0
                        ? `${overallOptimizedPoints.toLocaleString('en-US')} pts`
                        : 'downsampling…'}
                    </span>
                  </div>
                  <div className="hero-arrow" aria-hidden>→</div>
                  <div className="hero-metric accent">
                    <span className="hero-label">Reduction</span>
                    <span className="hero-value">
                      {overallReductionPct != null ? `${overallReductionPct.toFixed(2)}%` : '—'}
                    </span>
                    <span className="hero-sub">fewer points vs full dataset</span>
                  </div>
                </div>
              </div>
  
              <div className="reduction-panel">
                <div className="reduction-panel-title">Selected series</div>
                <p className="reduction-panel-desc">
                  Currently plotted: <strong>{selectedSeriesLabel}</strong>
                  {mode === 'raw' ? ' (raw mode draws these without LTTB)' : ' (optimized chart draw)'}.
                </p>
                <div className="hero-metrics nested">
                  <div className="hero-metric">
                    <span className="hero-label">Selected raw</span>
                    <span className="hero-value">
                      {selectedRawPoints > 0 ? formatPoints(selectedRawPoints) : '—'}
                    </span>
                    <span className="hero-sub">
                      {selectedRawPoints > 0 ? selectedRawPoints.toLocaleString('en-US') : '—'}
                    </span>
                  </div>
                  <div className="hero-arrow" aria-hidden>→</div>
                  <div className="hero-metric">
                    <span className="hero-label">Chart draw</span>
                    <span className="hero-value">
                      {renderedPoints > 0 ? formatPoints(renderedPoints) : '—'}
                    </span>
                    <span className="hero-sub">
                      {mode === 'optimized' ? 'LTTB output' : 'raw selected points'}
                    </span>
                  </div>
                  <div className="hero-arrow" aria-hidden>→</div>
                  <div className="hero-metric accent">
                    <span className="hero-label">Reduction</span>
                    <span className="hero-value">
                      {selectedReductionPct != null && mode === 'optimized'
                        ? `${selectedReductionPct.toFixed(2)}%`
                        : mode === 'raw'
                          ? 'n/a'
                          : '—'}
                    </span>
                    <span className="hero-sub">
                      {mode === 'optimized'
                        ? 'fewer points vs selected raw'
                        : 'raw mode — no downsample'}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </div>
  
          {/* Controls */}
          <section className="controls">
            <div className="control-group">
              <label htmlFor="dataset-size">Dataset size</label>
              <select
                id="dataset-size"
                value={datasetSize}
                onChange={(e) => setDatasetSize(Number(e.target.value))}
                disabled={generating}
              >
                {SIZE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s.toLocaleString('en-US')} points
                  </option>
                ))}
              </select>
            </div>
            <div className="control-group">
              <label>Stress test load</label>
              <div className="mode-toggle stress-toggle">
                {STRESS_SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={datasetSize === s ? 'mode-btn active' : 'mode-btn'}
                    disabled={generating}
                    onClick={() => setDatasetSize(s)}
                    title={`Generate and render ${s.toLocaleString('en-US')} points through the real pipeline`}
                  >
                    {formatPoints(s)}
                  </button>
                ))}
              </div>
            </div>
            <div className="control-group">
              <label>Rendering mode</label>
              <div className="mode-toggle">
                <button
                  type="button"
                  className={mode === 'raw' ? 'mode-btn active' : 'mode-btn'}
                  onClick={() => setMode('raw')}
                >
                  Raw
                </button>
                <button
                  type="button"
                  className={mode === 'optimized' ? 'mode-btn active' : 'mode-btn'}
                  onClick={() => setMode('optimized')}
                >
                  Optimized
                </button>
              </div>
            </div>
            <div className="control-group">
              <label htmlFor="time-range">Time range</label>
              <select
                id="time-range"
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as TimeRangeKey)}
              >
                <option value="all">All data</option>
                <option value="5m">Last 5 minutes</option>
                <option value="15m">Last 15 minutes</option>
                <option value="1h">Last 1 hour</option>
                <option value="6h">Last 6 hours</option>
              </select>
            </div>
            <div className="control-group">
              <label htmlFor="aggregation">Aggregation</label>
              <select
                id="aggregation"
                value={aggregation}
                onChange={(e) => setAggregation(e.target.value as AggregationBucket)}
              >
                <option value="none">None (no bucketing)</option>
                <option value="1m">1 minute</option>
                <option value="5m">5 minutes</option>
                <option value="1h">1 hour</option>
              </select>
            </div>
            <div className="control-group">
              <label htmlFor="table-category">Table category</label>
              <select
                id="table-category"
                value={tableCategory}
                onChange={(e) => setTableCategory(e.target.value)}
              >
                <option value="All">All</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="control-group">
              <label htmlFor="table-filter">Filter table</label>
              <input
                id="table-filter"
                type="text"
                placeholder="e.g. CPU"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="control-group">
              <label>Live stream</label>
              <div className="mode-toggle">
                <button
                  type="button"
                  className={streaming ? 'mode-btn active' : 'mode-btn'}
                  disabled={generating || rawData.length === 0}
                  onClick={() => setStreaming((v) => !v)}
                >
                  {streaming ? 'Streaming (100ms)' : 'Start stream'}
                </button>
              </div>
            </div>
            <button
              type="button"
              className="regen-btn"
              onClick={() => regenerate(datasetSize)}
              disabled={generating}
            >
              {generating ? 'Generating…' : 'Regenerate data'}
            </button>
          </section>
          <p className="pipeline-note">
            Pipeline: buffer → time range → aggregation ({aggregationLabel(aggregation)}) →
            {mode === 'optimized' ? ' LTTB in Web Worker → ' : ' '}
            Canvas2D. Aggregation buckets time; LTTB only reduces points for drawing.
          </p>
  
          {/* Series toggles */}
          <section className="series-toggles" aria-label="Visible metrics">
            <span className="series-label">Metrics</span>
            <div className="series-buttons">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={visibleSeries[cat] ? 'series-btn active' : 'series-btn'}
                  style={
                    visibleSeries[cat]
                      ? { borderColor: CATEGORY_COLORS[cat], color: CATEGORY_COLORS[cat] }
                      : undefined
                  }
                  onClick={() => toggleSeries(cat)}
                  aria-pressed={visibleSeries[cat]}
                >
                  <span className="series-swatch" style={{ background: CATEGORY_COLORS[cat] }} />
                  {cat}
                </button>
              ))}
            </div>
          </section>
  
          {/* Metric summary cards */}
          <div className="dashboard-card">
            <div className="dashboard-card-title">📈 System Metrics</div>
            <section className="summary-row">
              {CATEGORIES.map((cat) => (
                <div
                  className={`summary-card ${visibleSeries[cat] ? 'on' : 'off'}`}
                  key={cat}
                  style={{ borderTopColor: CATEGORY_COLORS[cat] }}
                >
                  <span className="metric-icon" style={{ background: CATEGORY_COLORS[cat] }} />
                  <div className="summary-card-content">
                    <span className="stat-label">{cat}</span>
                    <span className="stat-value">
                      {latestByCategory[cat] ? `${latestByCategory[cat].value.toFixed(1)}%` : '—'}
                    </span>
                  </div>
                </div>
              ))}
            </section>
          </div>
  
          {/* Performance section */}
          <div className="dashboard-card">
            <div className="dashboard-card-title">⚡ Performance</div>
            <div className="dashboard-card-subtitle">
              Dataset = full in-memory set. Rendered / Reduction = currently selected series
              {mode === 'optimized' ? ' after LTTB' : ' in raw mode'}.
            </div>
            <section className="perf-summary" aria-label="Performance summary">
              <div className="stats-row">
                <div className="stat-card">
                  <span className="stat-label">Dataset</span>
                  <span className="stat-value">{rawData.length.toLocaleString('en-US')}</span>
                  <span className="stat-hint">all metrics</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Rendered</span>
                  <span className="stat-value">{renderedPoints > 0 ? renderedPoints.toLocaleString('en-US') : '—'}</span>
                  <span className="stat-hint">selected series</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Reduction</span>
                  <span className="stat-value">
                    {reductionPct != null ? `${reductionPct.toFixed(2)}%` : mode === 'raw' ? 'n/a' : '—'}
                  </span>
                  <span className="stat-hint">vs selected raw</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Worker time</span>
                  <span className="stat-value">{mode === 'raw' ? 'N/A' : workerMs > 0 ? `${workerMs.toFixed(2)} ms` : '—'}</span>
                  <span className="stat-hint">{mode === 'raw' ? 'not used in raw mode' : 'selected series'}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Canvas render</span>
                  <span className="stat-value">
                    {mode === 'optimized' && optimizedMeasured
                      ? `${optimizedMeasured.ms.toFixed(2)} ms`
                      : mode === 'raw' && rawMeasured
                        ? `${rawMeasured.ms.toFixed(2)} ms`
                        : '—'}
                  </span>
                  <span className="stat-hint">measured draw</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Live FPS</span>
                  <span className="stat-value">{liveFps > 0 ? liveFps : '—'}</span>
                  <span className="stat-hint">display-limited</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">JS heap</span>
                  <span className="stat-value heap-stat-value">{heapLabel === 'Unavailable' ? 'N/A' : heapLabel.split(' · ')[0] || '—'}</span>
                  <span className="stat-hint">browser-reported · {heapLabel === 'Unavailable' ? 'Unavailable' : 'performance.memory'}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Data generation</span>
                  <span className="stat-value">{genMs > 0 ? `${genMs.toFixed(1)} ms` : '—'}</span>
                  <span className="stat-hint">main thread</span>
                </div>
              </div>
            </section>
          </div>
  
          {/* Raw warning */}
          {mode === 'raw' && selectedRawPoints > RAW_WARNING_THRESHOLD && (
            <div className="raw-warning">
              Rendering {selectedRawPoints.toLocaleString('en-US')} selected-series points directly, with no
              downsampling. This may impact responsiveness on slower devices.
            </div>
          )}
  
          {/* Chart */}
          <div className="dashboard-card">
            <div className="dashboard-card-title">📉 Time-Series Chart</div>
            <div className="control-group chart-type-group">
              <label>Chart type</label>
              <div className="mode-toggle" role="group" aria-label="Chart type">
                {(
                  [
                    ['line', 'Line'],
                    ['bar', 'Bar'],
                    ['scatter', 'Scatter'],
                    ['heatmap', 'Heatmap'],
                  ] as const
                ).map(([id, name]) => (
                  <button
                    key={id}
                    type="button"
                    className={chartType === id ? 'mode-btn active' : 'mode-btn'}
                    onClick={() => setChartType(id)}
                    aria-pressed={chartType === id}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <p className="chart-type-hint">
                {chartType === 'line' &&
                  'Line uses the existing Canvas path; Optimized mode still applies Web Worker + LTTB.'}
                {chartType === 'bar' &&
                  'Bar uses mean values in a fixed number of time buckets (not one bar per raw point).'}
                {chartType === 'scatter' &&
                  'Scatter plots real samples with stride LOD so large sets stay interactive.'}
                {chartType === 'heatmap' &&
                  'Heatmap bins time × value density — not a recolored line chart.'}
              </p>
            </div>
            {generating ? (
              <div className="chart-placeholder" role="status">
                Generating {datasetSize.toLocaleString('en-US')} points…
              </div>
            ) : chartReady && chartSeries.length > 0 ? (
              <CanvasChart
                series={chartSeries}
                label={chartLabel}
                chartType={chartType}
                measureMode={mode}
                measureConfigKey={benchmarkConfigKey}
                onRender={handleChartRender}
              />
            ) : activeCategories.length === 0 ? (
              <div className="chart-placeholder">Enable at least one metric to plot.</div>
            ) : (
              <div className="chart-placeholder" role="status">
                {mode === 'optimized'
                  ? `Downsampling selected series (${selectedSeriesLabel}) in Web Worker…`
                  : 'Preparing raw series…'}
              </div>
            )}
          </div>
  
          {/* Raw vs Optimized comparison */}
          <div className="dashboard-card">
            <section className="comparison-card">
              <div className="comparison-title">Raw vs Optimized</div>
              <p className="comparison-hint">
                Point counts below are for the <strong>currently selected series</strong> (
                {selectedSeriesLabel}). Switch modes to populate measured canvas timings for this browser.
                Values are never fabricated.
              </p>
              <div className="compare-table">
                <div className="compare-row head">
                  <span />
                  <span>Raw</span>
                  <span>Optimized</span>
                </div>
                <div className="compare-row">
                  <span className="compare-key">Points</span>
                  <span>{selectedRawPoints > 0 ? selectedRawPoints.toLocaleString('en-US') : '—'}</span>
                  <span>
                    {selectedOptimizedPoints > 0 ? selectedOptimizedPoints.toLocaleString('en-US') : '—'}
                  </span>
                </div>
                <div className="compare-row">
                  <span className="compare-key">Render time</span>
                  <span>{rawMeasured ? `${rawMeasured.ms.toFixed(2)} ms` : 'Not measured yet'}</span>
                  <span>
                    {optimizedMeasured ? `${optimizedMeasured.ms.toFixed(2)} ms` : 'Not measured yet'}
                  </span>
                </div>
                <div className="compare-row">
                  <span className="compare-key">Live FPS</span>
                  <span>{rawMeasuredFps != null ? rawMeasuredFps : 'Not measured yet'}</span>
                  <span>{optimizedMeasuredFps != null ? optimizedMeasuredFps : 'Not measured yet'}</span>
                </div>
                <div className="compare-row">
                  <span className="compare-key">Processing</span>
                  <span>Main thread</span>
                  <span>Web Worker + LTTB</span>
                </div>
                <div className="compare-row">
                  <span className="compare-key">Rendering</span>
                  <span>Canvas2D</span>
                  <span>Canvas2D</span>
                </div>
                {rawMeasured && optimizedMeasured && (
                  <div className="compare-row highlight-row">
                    <span className="compare-key">Speedup</span>
                    <span className="compare-span">
                      {(rawMeasured.ms / Math.max(optimizedMeasured.ms, 0.01)).toFixed(1)}× faster draw
                      (this run)
                    </span>
                  </div>
                )}
              </div>
            </section>
          </div>
  
          {/* Data Explorer */}
          <div className="dashboard-card">
            <div className="dashboard-card-title">🗂️ Data Explorer</div>
            <div className="dashboard-card-subtitle">
              {filteredRawData.length.toLocaleString('en-US')} rows · virtualized rendering
            </div>
            <VirtualTable data={filteredRawData} />
          </div>
  
          <footer className="app-footer">
            <p>
              Architecture: each category is a Float64Array pair transferred to a Web Worker for LTTB
              downsampling (zero-copy transfer list), then drawn with Canvas2D (one stroke per series).
              The table virtualizes rows so DOM node count stays flat from 10k to 500k. Live FPS is
              measured via requestAnimationFrame and is capped by your display refresh rate, browser,
              and hardware — it is not a guaranteed throughput claim.
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}

