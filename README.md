# Performance-Critical Data Visualization Dashboard

## Project overview

A **Next.js 14 App Router** browser application that generates and visualizes large multi-series time-series datasets (up to **500,000 points**) without Chart.js, D3, Recharts, or similar libraries.

The focus is browser-side performance: Web Workers, LTTB downsampling, typed arrays with transferable `ArrayBuffer`s, Canvas2D rendering, and a virtualized data table. Metrics shown in the UI (canvas draw time, worker time, FPS, JS heap) come from **real measurements** in the current browser session — never fabricated placeholders.

## Key features

- Dataset sizes: **10K / 50K / 100K / 250K / 500K** (stress-test shortcuts for 10K / 50K / 100K / 500K)
- Metric-specific synthetic generators (CPU, Memory, Network, Disk I/O)
- **Raw vs Optimized** rendering modes with genuine canvas timing capture
- Chart types: **Line**, **Bar**, **Scatter**, **Heatmap** (all Canvas2D)
- Web Worker + **LTTB** for Optimized line (and as input LOD for other types)
- Typed arrays + transferable buffers
- Virtualized Data Explorer
- Live FPS HUD (`requestAnimationFrame`) and per-mode FPS samples
- Browser JS heap display via `performance.memory` when available
- **100ms** simulated real-time stream
- Aggregation: **none / 1m / 5m / 1h** (distinct from LTTB)
- Time-range filter: All / 5m / 15m / 1h / 6h
- Zoom (scroll) and pan (drag) on the canvas
- App Router `loading` / `error` boundaries
- Minimal sample API at `/api/data` (does **not** process the 500K visualization on the server)

## Technology stack

| Layer | Choice |
|--------|--------|
| Framework | Next.js 14 (App Router) |
| UI | React 18 + TypeScript |
| Charts | Custom Canvas2D (no chart libraries) |
| Workers | Web Worker + LTTB (`workers/dataWorker.ts`) |
| Styling | CSS (existing dark dashboard theme) |
| Tooling | `tsc --noEmit`, `next build` |

## Architecture overview

```
app/
  layout.tsx              Root layout + global CSS
  page.tsx                Redirect → /dashboard
  dashboard/
    page.tsx              Server page → client <Dashboard />
    loading.tsx / error.tsx
  api/data/route.ts       Tiny sample JSON (100 points)
components/
  Dashboard.tsx           Client orchestration, controls, benchmarks
  CanvasChart.tsx         Line / Bar / Scatter / Heatmap (Canvas2D)
  VirtualTable.tsx        Windowed row rendering
  PerfHUD.tsx             Live display-loop FPS
lib/
  dataGenerator.ts        Synthetic data + typed grouping
  lttb.ts                 LTTB downsampling
  aggregate.ts            Time-bucket aggregation (1m/5m/1h)
  stream.ts               100ms stream tick + time-range filter
  chartLod.ts             Bar buckets / scatter LOD / heatmap bins
workers/
  dataWorker.ts           LTTB on transferable Float64Arrays
```

**Pipeline (Optimized mode):**

`generate / stream → time-range filter → aggregation → Float64Array pairs → Web Worker (LTTB, transferable) → Canvas2D chart type`

**Pipeline (Raw mode):** same filters/aggregation, then typed arrays drawn **without** Worker/LTTB (line path strokes full selected series).

## Setup instructions

```bash
# From the project root (perf-dashboard/)
npm install
```

Requires Node.js 18+ recommended for Next.js 14.

## Development command

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — root redirects to `/dashboard`.

## Production build / run commands

```bash
npm run typecheck   # tsc --noEmit
npx next build      # or: npm run build
npm start           # serve the production build
```

## Performance testing instructions

1. Open `/dashboard` in Chrome or Edge (best support for `performance.memory`).
2. Use **Stress test load** (10K / 50K / 100K / 500K) or the dataset size select.
3. Enable the series you care about (default: CPU + Memory).
4. Set **Rendering mode** to **Optimized**, wait for the chart, note **Canvas render** and Worker time.
5. Switch to **Raw**, wait for a draw, compare **Raw vs Optimized** table (values appear only after each mode has actually drawn).
6. Optionally start **Live stream (100ms)**, change aggregation / time range / chart type, and observe FPS / heap.
7. Do **not** treat Live FPS as an “app throughput” score — it is display-refresh–limited (see PERFORMANCE.md).

Unmeasured cells show **“Not measured yet”** until you visit that mode for the current dataset/series/filter config.

## Dataset sizes supported

| Size | Notes |
|------|--------|
| 10,000 | Quick iteration |
| 50,000 | Medium load |
| 100,000 | Stress; Raw mode warns above this for selected series |
| 250,000 | Large (selector) |
| 500,000 | Primary assignment target |

Stress-test buttons cover **10K / 50K / 100K / 500K** using the same generator and render pipeline.

## Chart types

| Type | Behavior |
|------|----------|
| **Line** | Existing multi-series stroke path; Optimized uses Worker + LTTB |
| **Bar** | Mean values in a fixed number of time buckets (not one bar per raw point) |
| **Scatter** | Real samples with stride LOD (~2500 markers/series max) |
| **Heatmap** | Real time × value density bins (not a recolored line) |

Selector is on the chart card and actually switches Canvas draw mode over the same `chartSeries` data.

## Web Worker + LTTB explanation

- Each category becomes a `{ timestamps: Float64Array, values: Float64Array }` pair.
- Copies are **transferred** to `workers/dataWorker.ts` via `postMessage(..., [buffer, buffer])` (zero-copy ownership handoff).
- The worker runs **Largest-Triangle-Three-Buckets (LTTB)** to a per-series threshold (~400–1200 points depending on how many series are active).
- Results are transferred back and drawn on Canvas.
- While streaming, worker posts are **debounced (~400ms)** so 100ms ticks do not flood the main thread.

LTTB preserves visual shape (peaks/valleys) better than naive stride sampling for the **line** chart.

## Canvas rendering explanation

- All four chart types use a single `<canvas>` and the **2D context** — no SVG series nodes, no chart library.
- **Line:** one `stroke()` per series.
- **Bar / Scatter / Heatmap:** additional LOD/binning in `lib/chartLod.ts` so hundreds of thousands of input points do not become hundreds of thousands of draw calls.
- Draw duration is timed with `performance.now()` around the paint path and recorded once per Raw/Optimized session for the current config.

## Virtualized table explanation

`VirtualTable` mounts only rows in the scroll viewport (+ overscan). DOM node count stays roughly constant whether the explorer shows thousands or hundreds of thousands of filtered rows.

## Real-time 100ms stream explanation

- **Start stream** appends one new sample per category every **100ms**.
- Oldest points are trimmed so the in-memory buffer stays within the selected dataset size.
- Stream does **not** re-run full `generateDataset`; it only creates four lightweight points per tick.
- Worker downsampling is debounced while streaming.

## Aggregation options (1m / 5m / 1h)

Implemented in `lib/aggregate.ts` as real time-bucket **means** (per category):

- **None** — no bucketing; Optimized still may apply LTTB for drawing
- **1 minute / 5 minutes / 1 hour** — collapse points into fixed windows before typing/Worker

**Aggregation ≠ LTTB:** aggregation changes the analytical resolution of the series; LTTB is a visual downsampling step for Canvas in Optimized mode.

## Zoom / pan / time-range / filter controls

- **Zoom:** mouse wheel over the chart (time-domain window)
- **Pan:** drag on the chart
- **Reset view:** restores full domain after zoom/pan
- **Time range:** All / Last 5m / 15m / 1h / 6h — real filter on timestamps relative to the dataset max time
- **Table category + text filter:** affect the Data Explorer (and use the current working set after range/aggregation)
- **Series toggles:** which metrics feed the chart

## Browser compatibility notes

| Feature | Notes |
|---------|--------|
| Canvas2D, Workers, typed arrays | Modern Chromium, Firefox, Safari |
| `performance.memory` | **Chrome / Edge** (non-standard). Elsewhere UI shows **Unavailable** |
| Live FPS | Measured via `requestAnimationFrame`; capped by display refresh (e.g. 60 / 120 / 144 Hz) |
| Transferable `ArrayBuffer` | Required for the Worker path |

## Screenshots

> Place screenshots in `docs/screenshots/` (or update paths below) after capturing locally.

| View | Placeholder |
|------|-------------|
| Dashboard overview | `![Dashboard](docs/screenshots/dashboard.png)` |
| Optimized line chart | `![Line Optimized](docs/screenshots/line-optimized.png)` |
| Raw vs Optimized table | `![Benchmark](docs/screenshots/raw-vs-optimized.png)` |
| Heatmap / Bar / Scatter | `![Chart types](docs/screenshots/chart-types.png)` |
| Data Explorer | `![Table](docs/screenshots/data-explorer.png)` |

*(Image files are not committed yet — paths are placeholders.)*

## Next.js-specific architecture decisions

- **App Router** with `/` → `/dashboard` redirect.
- Interactive visualization lives in **Client Components** (`"use client"`): `Dashboard`, `CanvasChart`, `VirtualTable`, `PerfHUD`.
- Pure logic stays in **`lib/`** and **`workers/`** (framework-independent).
- **`/api/data`** returns a **small** sample (`generateDataset(100)`); the 500K visualization remains **client-side** by design.
- Webpack `output.globalObject = 'self'` in `next.config.mjs` so Worker URLs work in production bundles.
- Workers constructed with `new Worker(new URL('../workers/dataWorker.ts', import.meta.url))`.

## Limitations / known browser API limitations

- `performance.memory` is not available in all browsers → UI reports **Unavailable** (no invented MB).
- Live FPS is **display-limited**, not a guaranteed processing throughput claim.
- Raw mode with very large selected series can stall the main thread (warning above 100K selected points).
- Heatmap/bar/scatter apply LOD/binning; they are not a substitute for statistical analysis tools.
- Memory growth over hours and interaction latency budgets are **not** claimed unless measured (see PERFORMANCE.md).

## Production deployment instructions

1. `npm install`
2. `npm run typecheck`
3. `npx next build`
4. `npm start` (or deploy the `.next` output to a Node host such as Vercel, or your own Node 18+ server)

Environment: no secrets required for the default demo. Ensure the host serves the Worker chunk over HTTPS (or localhost) so module/worker loading is allowed.

Example (Vercel): connect the repo and use the default Next.js build (`next build`) / start settings.
