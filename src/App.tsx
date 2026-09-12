import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { generateDataset, groupByCategoryTyped, CATEGORIES, type DataPoint } from './lib/dataGenerator';
import { CanvasChart, type ChartSeries } from './components/CanvasChart';
import { VirtualTable } from './components/VirtualTable';
import { PerfHUD } from './components/PerfHUD';
import type { WorkerResponse } from './workers/dataWorker';
import './App.css';

const CATEGORY_OPTIONS = ['All', ...CATEGORIES];
const SIZE_OPTIONS = [10_000, 50_000, 100_000, 250_000, 500_000];
const CATEGORY_COLORS: Record<string, string> = {
  CPU: '#6366f1',
  Memory: '#22c55e',
  Network: '#f59e0b',
  'Disk I/O': '#ec4899',
};
const RAW_WARNING_THRESHOLD = 100_000;

function App() {
  const [datasetSize, setDatasetSize] = useState(100_000);
  const [rawData, setRawData] = useState<DataPoint[]>([]);
  const [category, setCategory] = useState('All');
  const [genMs, setGenMs] = useState(0);
  const [workerMs, setWorkerMs] = useState(0);
  const [downsampledByCategory, setDownsampledByCategory] = useState<Record<string, ChartSeries>>({});
  const [statsByCategory, setStatsByCategory] = useState<Record<string, { min: number; max: number; avg: number; count: number }>>({});
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'raw' | 'optimized'>('optimized');
  const [rawMeasured, setRawMeasured] = useState<{ ms: number; points: number } | null>(null);
  const [optimizedMeasured, setOptimizedMeasured] = useState<{ ms: number; points: number } | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL('./workers/dataWorker.ts', import.meta.url), {
      type: 'module',
    });
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
        setWorkerMs(res.durationMs);
      } else if (res.type === 'AGGREGATE_RESULT') {
        setStatsByCategory((prev) => ({ ...prev, [res.category]: res.stats }));
      }
    };
    return () => workerRef.current?.terminate();
  }, []);

  const regenerate = useCallback((size: number) => {
    const t0 = performance.now();
    const data = generateDataset(size);
    setGenMs(performance.now() - t0);
    setRawData(data);
  }, []);

  useEffect(() => {
    regenerate(datasetSize);
  }, [datasetSize, regenerate]);

  // Grouped once per dataset — one Float64Array pair per category. This is
  // the structure both the chart (multi-series) and the worker requests
  // (transferable buffers) are built from.
  const typedByCategory = useMemo(() => groupByCategoryTyped(rawData), [rawData]);

  // Clear stale measurements/results whenever the underlying dataset/category
  // changes, so comparisons never mix numbers from two different runs.
  useEffect(() => {
    setRawMeasured(null);
    setOptimizedMeasured(null);
    setDownsampledByCategory({});
    setStatsByCategory({});
  }, [rawData, category]);

  useEffect(() => {
    if (rawData.length === 0 || !workerRef.current) return;
    const categoriesToRequest = category === 'All' ? CATEGORIES : [category];
    const perSeriesThreshold = category === 'All' ? 400 : 1200; // fewer pts/series when overlaying 4 lines

    for (const cat of categoriesToRequest) {
      const src = typedByCategory[cat];
      if (!src) continue;
      // .slice() copies before transfer, so the canonical typedByCategory
      // arrays (also used for Raw mode) stay intact — only the copy's
      // ownership moves to the worker.
      const timestamps = src.timestamps.slice();
      const values = src.values.slice();
      workerRef.current.postMessage(
        { type: 'DOWNSAMPLE_TYPED', category: cat, timestamps, values, threshold: perSeriesThreshold },
        [timestamps.buffer, values.buffer]
      );
      const aggValues = src.values.slice();
      workerRef.current.postMessage(
        { type: 'AGGREGATE_TYPED', category: cat, values: aggValues },
        [aggValues.buffer]
      );
    }
  }, [rawData, category, typedByCategory]);

  const filteredRawData = useMemo(() => {
    let d = category === 'All' ? rawData : rawData.filter((p) => p.category === category);
    if (search.trim()) {
      const term = search.toLowerCase();
      d = d.filter((p) => p.category.toLowerCase().includes(term));
    }
    return d;
  }, [rawData, category, search]);

  // Latest reading per category, for the top summary cards.
  const latestByCategory = useMemo(() => {
    const result: Record<string, DataPoint> = {};
    for (const p of rawData) {
      result[p.category] = p; // data is sorted by timestamp, so last write wins
    }
    return result;
  }, [rawData]);

  const activeCategories = category === 'All' ? CATEGORIES : [category];

  // Optimized: the LTTB-downsampled series the worker sent back, per category.
  const optimizedSeries: ChartSeries[] = activeCategories
    .map((cat) => downsampledByCategory[cat])
    .filter((s): s is ChartSeries => Boolean(s));

  // Raw mode: full (undownsampled) series per category, straight from the
  // typed grouping — each category is its own line, so this no longer
  // interleaves unrelated series the way the flat sorted array used to.
  const rawSeries: ChartSeries[] = activeCategories
    .map((cat) => {
      const src = typedByCategory[cat];
      if (!src) return null;
      return { name: cat, color: CATEGORY_COLORS[cat] ?? '#6366f1', timestamps: src.timestamps, values: src.values };
    })
    .filter((s): s is ChartSeries => Boolean(s));

  const chartSeries = mode === 'raw' ? rawSeries : optimizedSeries;
  const rawPointCount = rawSeries.reduce((sum, s) => sum + s.values.length, 0);

  const handleChartRender = useCallback(
    (durationMs: number, pointCount: number) => {
      if (mode === 'raw') setRawMeasured({ ms: durationMs, points: pointCount });
      else setOptimizedMeasured({ ms: durationMs, points: pointCount });
    },
    [mode]
  );

  // Combine per-category stats into one summary when "All" is selected.
  const combinedStats = useMemo(() => {
    const relevant = activeCategories.map((c) => statsByCategory[c]).filter(Boolean);
    if (relevant.length === 0) return null;
    return {
      min: Math.min(...relevant.map((s) => s.min)),
      max: Math.max(...relevant.map((s) => s.max)),
      avg: relevant.reduce((sum, s) => sum + s.avg * s.count, 0) / relevant.reduce((sum, s) => sum + s.count, 0),
      count: relevant.reduce((sum, s) => sum + s.count, 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsByCategory, category]);

  return (
    <div className="app">
      <PerfHUD />
      <header className="app-header">
        <h1>Performance-Critical Data Visualization Dashboard</h1>
        <p className="subtitle">
          Frontend R&amp;D — rendering large time-series datasets without dropping frames
        </p>
      </header>

      <section className="controls">
        <div className="control-group">
          <label>Dataset size</label>
          <select value={datasetSize} onChange={(e) => setDatasetSize(Number(e.target.value))}>
            {SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.toLocaleString()} points
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label>Filter table</label>
          <input
            type="text"
            placeholder="e.g. CPU"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="control-group">
          <label>Rendering mode</label>
          <div className="mode-toggle">
            <button
              className={mode === 'raw' ? 'mode-btn active' : 'mode-btn'}
              onClick={() => setMode('raw')}
            >
              Raw
            </button>
            <button
              className={mode === 'optimized' ? 'mode-btn active' : 'mode-btn'}
              onClick={() => setMode('optimized')}
            >
              Optimized
            </button>
          </div>
        </div>
        <button className="regen-btn" onClick={() => regenerate(datasetSize)}>
          ↻ Regenerate data
        </button>
      </section>

      <section className="summary-row">
        {CATEGORIES.map((cat) => (
          <div className="summary-card" key={cat}>
            <span className="stat-label">{cat}</span>
            <span className="stat-value">
              {latestByCategory[cat] ? latestByCategory[cat].value.toFixed(1) : '—'}
            </span>
          </div>
        ))}
      </section>

      <section className="stats-row">
        <div className="stat-card">
          <span className="stat-label">Raw points</span>
          <span className="stat-value">{rawData.length.toLocaleString()}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Data generation</span>
          <span className="stat-value">{genMs.toFixed(1)} ms</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Worker downsample</span>
          <span className="stat-value">{workerMs.toFixed(2)} ms</span>
        </div>
        {combinedStats && (
          <>
            <div className="stat-card">
              <span className="stat-label">Min / Max</span>
              <span className="stat-value">{combinedStats.min.toFixed(1)} / {combinedStats.max.toFixed(1)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Avg</span>
              <span className="stat-value">{combinedStats.avg.toFixed(2)}</span>
            </div>
          </>
        )}
      </section>

      {mode === 'raw' && rawPointCount > RAW_WARNING_THRESHOLD && (
        <div className="raw-warning">
          ⚠ Rendering {rawPointCount.toLocaleString()} points directly, with no downsampling.
          This may impact responsiveness on slower devices.
        </div>
      )}

      {chartSeries.length > 0 ? (
        <CanvasChart
          series={chartSeries}
          label={
            mode === 'raw'
              ? `${category} — raw (all points, no downsampling)`
              : `${category} — optimized (canvas, LTTB-downsampled per series)`
          }
          onRender={handleChartRender}
        />
      ) : (
        <div className="chart-placeholder">Crunching {rawData.length.toLocaleString()} points…</div>
      )}

      {(rawMeasured || optimizedMeasured) && (
        <div className="comparison-card">
          <div className="comparison-title">Measured render time (this browser, just now)</div>
          <div className="comparison-row">
            <div className="comparison-col">
              <span className="comparison-label">Raw</span>
              <span className="comparison-value">
                {rawMeasured ? `${rawMeasured.ms.toFixed(1)} ms · ${rawMeasured.points.toLocaleString()} pts` : 'switch to Raw to measure'}
              </span>
            </div>
            <div className="comparison-col">
              <span className="comparison-label">Optimized</span>
              <span className="comparison-value">
                {optimizedMeasured ? `${optimizedMeasured.ms.toFixed(2)} ms · ${optimizedMeasured.points.toLocaleString()} pts` : 'switch to Optimized to measure'}
              </span>
            </div>
            {rawMeasured && optimizedMeasured && (
              <div className="comparison-col">
                <span className="comparison-label">Speedup</span>
                <span className="comparison-value highlight">
                  {(rawMeasured.ms / Math.max(optimizedMeasured.ms, 0.01)).toFixed(1)}×
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <h2 className="section-title">Raw data table (virtualized)</h2>
      <VirtualTable data={filteredRawData} />

      <footer className="app-footer">
        <p>
          Architecture notes: each category is grouped into its own Float64Array pair on the main
          thread, so "All categories" renders four independent lines instead of one line jumping
          between unrelated series. Those typed arrays are handed to a Web Worker via postMessage's
          transfer list — a zero-copy pointer handoff — instead of structured-cloning an array of
          {'{timestamp, value, category, volume}'} objects on every request. The worker runs LTTB
          downsampling per series and transfers the result back the same way. The chart draws with
          raw Canvas2D (one stroke() call per series) and the table virtualizes rows so DOM node
          count stays flat whether the dataset is 10k or 500k rows.
        </p>
      </footer>
    </div>
  );
}

export default App;
