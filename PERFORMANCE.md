# PERFORMANCE.md

Performance notes for the **Performance-Critical Data Visualization Dashboard** (Next.js 14 App Router).

This document describes **how** the app measures and optimizes. It does **not** invent benchmark numbers. Values that only appear after you run the app in a browser are marked **Not yet measured** until captured in that session.

---

## 1. Performance testing methodology

1. Use a production build when comparing timings (`npx next build && npm start`) to avoid dev-mode overhead.
2. Prefer Chrome or Edge for heap metrics (`performance.memory`).
3. Fix dataset size, visible series, time range, and aggregation before comparing Raw vs Optimized.
4. Load **Optimized**, wait for Worker + first canvas draw → timings fill for Optimized.
5. Switch to **Raw**, wait for draw → Raw timings fill.
6. Record only what the UI shows for that config (canvas ms, worker ms, mode FPS, live FPS, heap).
7. Changing dataset, series selection, time range, aggregation, or chart type starts a **new** benchmark session (in-memory); previous numbers for the old config are cleared.

The UI never fabricates “Not measured yet” cells.

---

## 2. Dataset sizes tested

Supported in the app (same generator + pipeline):

| Points | Role |
|--------|------|
| 10,000 | Smoke / fast iteration |
| 50,000 | Medium |
| 100,000 | Stress (Raw warns if selected series exceed this) |
| 250,000 | Large (dropdown) |
| 500,000 | Primary load target |

**Results for a specific machine/browser:** Not yet measured in this document — capture from the dashboard’s Performance card and Raw vs Optimized table after running locally.

---

## 3. Raw vs Optimized methodology

| Mode | Data path | What is timed |
|------|-----------|----------------|
| **Optimized** | Filter → aggregation → typed arrays → **Worker LTTB** (transferable) → Canvas | Worker duration (sum of selected series) + canvas `performance.now()` draw |
| **Raw** | Filter → aggregation → typed arrays → Canvas (**no** Worker/LTTB) | Canvas draw only (Worker shown as N/A) |

- At most **one** canvas timing sample is stored per mode per config key.
- Point counts in the comparison table are for the **currently selected series** (after range/aggregation for the working set).
- Speedup row appears only when **both** Raw and Optimized canvas samples exist: `rawMs / max(optimizedMs, 0.01)`.

---

## 4. Web Worker architecture

- Client creates: `new Worker(new URL('../workers/dataWorker.ts', import.meta.url))`.
- Messages: `DOWNSAMPLE_TYPED` with `Float64Array` timestamps/values + threshold.
- Transfer list passes buffers so the main thread does not structured-clone large arrays.
- Worker returns `DOWNSAMPLE_RESULT` with downsampled typed arrays + `durationMs`.
- During **100ms streaming**, downsample posts are **debounced (~400ms)** to avoid saturating the main thread and worker queue.

---

## 5. LTTB explanation

**Largest-Triangle-Three-Buckets** (`lib/lttb.ts`) selects a representative subset that preserves visual extrema better than uniform stride sampling.

- Applied **per category** in the worker for Optimized mode.
- Threshold scales with active series count (~1200 / ~800 / ~400 points per series for 1 / 2 / 3+ series).
- Purpose: fit the chart’s visual resolution, not replace analytical aggregation.

---

## 6. TypedArray / transferable buffer explanation

- `groupByCategoryTyped()` builds `Float64Array` pairs per metric (no per-point `{category}` object overhead on the wire).
- `postMessage(msg, [timestamps.buffer, values.buffer])` **transfers** ownership (O(1) handoff).
- After transfer, the sender’s views are detached; the worker (or main thread on return) owns the memory.

---

## 7. Canvas rendering approach

- Single Canvas2D surface; DPR-aware backing store.
- **Line:** one path `stroke()` per series (classic optimized path).
- **Bar:** mean per time bucket (`lib/chartLod.ts`), fixed bucket count — not one rect per raw point.
- **Scatter:** stride LOD capped (~2500 points/series).
- **Heatmap:** 2D time × value histogram with density coloring.
- Zoom/pan adjust the visible time window; draw is clipped to the plot area.

Draw cost is measured around the full paint for the active chart type.

---

## 8. Virtualization approach

`VirtualTable`:

- Computes `startIndex` / `endIndex` from `scrollTop`, row height, and viewport height.
- Renders only that window + overscan.
- Absolute positioning inside a full-height spacer so scrollbars reflect total rows.
- Resets scroll when the data reference changes (e.g. filter/regenerate).

DOM node count stays roughly constant as row count grows.

---

## 9. Real-time 100ms stream architecture

- `setInterval(..., 100)` while streaming is enabled.
- `appendStreamTick` adds **four** points (one per category) and trims to `datasetSize`.
- Does not call full `generateDataset` on each tick.
- Clears stream on regenerate; cleans up the interval on unmount / stop.
- Worker updates debounced while streaming.

---

## 10. Aggregation vs LTTB distinction

| Step | What it does |
|------|----------------|
| **Aggregation (1m / 5m / 1h)** | Analytical bucketing: mean value (and volume) per time window **before** typing/Worker |
| **LTTB** | Visual downsampling for Optimized drawing after (optional) aggregation |

UI copy on the dashboard states this pipeline explicitly. Aggregation can run in both Raw and Optimized; LTTB runs only on the Optimized Worker path.

---

## 11. FPS measurement methodology

### Live / display-loop FPS (top-right HUD + Performance “Live FPS”)

- `PerfHUD` counts frames via `requestAnimationFrame` over ~500ms windows.
- Reported number is **capped by display refresh rate**, compositor, browser, and hardware.
- Seeing **60 / 120 / 144** means the display loop is keeping up with the refresh ceiling under current load — **not** a claim that the app’s data pipeline “achieves 144 FPS throughput.”

### Mode-specific FPS (Raw vs Optimized table)

- Separate rAF sample taken while that mode’s chart is actually mounted (`chartReady`).
- Stored once per mode per config as `rawMeasuredFps` / `optimizedMeasuredFps`.
- **Not** a copy of the HUD value into both columns.
- Until sampled: **Not measured yet**.

---

## 12. Memory measurement methodology

- Polls `performance.memory` (~1s) when present (Chrome/Edge).
- Displays used JS heap vs limit (MB), labeled as **browser-reported** heap.
- If the API is missing: **Unavailable** — no invented memory figures.
- Long-running leak / “&lt;1MB per hour” growth: **Not yet measured** in this document.

---

## 13. Interaction performance methodology

- Zoom/pan update a fractional time window and redraw Canvas.
- No separate automated interaction latency harness is shipped.
- Claimed “&lt;100ms interaction latency”: **Not yet measured** as a formal SLA in this repo.
- Subjective responsiveness should be judged live; Raw + 500K selected points can jam the main thread (by design for contrast with Optimized).

---

## 14. Bottleneck analysis

| Area | Risk | Mitigation in this app |
|------|------|-------------------------|
| Main-thread generation of 500K objects | Brief block on regenerate | `requestAnimationFrame` yield before sync generate; show Generating state |
| Structured clone of large arrays to workers | High cost | Transferable `Float64Array` buffers |
| Drawing 500K line segments | Severe jank | LTTB in Optimized; Raw warns at high selected counts |
| Streaming + Worker every 100ms | Queue thrash | Debounced worker posts |
| Huge DOM tables | Layout thrash | Virtualization |
| Bar/scatter/heatmap primitives | Draw explosion | Bucket / stride / 2D bins |

---

## 15. Scaling strategy for 100K+ and 1M+ points

**Current (≤500K):**

- Prefer Optimized + LTTB for interactive charts.
- Use aggregation and time-range to shrink the working set.
- Stream with bounded buffer size.
- Avoid Raw for multi-series 100K+ unless intentionally stress-testing.

**Toward 1M+ (not fully implemented — guidance only):**

- Generate directly into typed arrays (skip large `DataPoint[]` where possible).
- OffscreenCanvas / worker-side rasterization.
- IndexedDB or chunked loading.
- Stronger progressive LOD keyed to zoom window.

1M+ end-to-end results: **Not yet measured**.

---

## 16. React performance optimizations actually used

- Client components for browser APIs only.
- `useMemo` for typed grouping, filtered table data, series assembly, worker time sums.
- `useCallback` for regenerate and chart render handlers.
- Benchmark/FPS state updates avoid wiping sibling mode samples.
- Stream updates append/trim rather than full regenerate.
- Virtual table limits React/DOM nodes.

No React Compiler claims; no unjustified `useMemo`/`useCallback` sprawl beyond existing patterns.

---

## 17. Next.js App Router architecture actually used

- `app/layout.tsx` — root HTML + CSS imports.
- `app/page.tsx` — redirect to `/dashboard`.
- `app/dashboard/page.tsx` — server entry rendering client `<Dashboard />`.
- `app/dashboard/loading.tsx` / `error.tsx` — route-level UX.
- `app/error.tsx` — root error UI.
- `app/api/data/route.ts` — sample API only.

---

## 18. Server vs Client Component decisions

| Server | Client (`"use client"`) |
|--------|-------------------------|
| Route shells, metadata, redirect, API sample | Dashboard, CanvasChart, VirtualTable, PerfHUD, error UIs |

500K generation, Workers, Canvas, streaming, and benchmarks run **only on the client**.

---

## 19. API route explanation

`GET /api/data`:

- Calls `generateDataset(100)`.
- Returns JSON `{ count, sample: first 20 points, note }`.
- Exists to demonstrate App Router API routes.
- **Does not** host the main visualization workload.

---

## 20. Loading / error boundaries

- `app/dashboard/loading.tsx` — pending UI for the dashboard segment.
- `app/dashboard/error.tsx` — client error boundary with reset.
- `app/error.tsx` — root-level fallback.
- In-dashboard banners for generation / Worker failures with Retry.

---

## 21. Browser limitations

- `performance.memory` non-standard → **Unavailable** outside supporting browsers.
- FPS ceiling = display refresh + browser scheduling.
- Safari/Firefox Workers + Canvas work; heap readout may not.
- Mixed content / strict COOP may block Workers if mis-deployed — serve over HTTPS or localhost.

---

## 22. Benchmark results table

Fill these from a **real** session on your machine. Until then, cells stay **Not yet measured**.

### Environment (fill in when testing)

| Field | Value |
|-------|--------|
| Browser / version | Not yet measured |
| OS | Not yet measured |
| Display refresh | Not yet measured (e.g. 60 / 120 / 144 Hz) |
| Build | `next build` + `next start` recommended |
| Dataset / series / range / agg / chart | Not yet measured |

### Canvas draw & worker (from UI)

| Dataset | Mode | Selected series points | Canvas draw (ms) | Worker (ms) | Notes |
|---------|------|------------------------|------------------|-------------|-------|
| 10,000 | Optimized | — | Not yet measured | Not yet measured | |
| 10,000 | Raw | — | Not yet measured | N/A | |
| 50,000 | Optimized | — | Not yet measured | Not yet measured | |
| 50,000 | Raw | — | Not yet measured | N/A | |
| 100,000 | Optimized | — | Not yet measured | Not yet measured | |
| 100,000 | Raw | — | Not yet measured | N/A | |
| 500,000 | Optimized | — | Not yet measured | Not yet measured | |
| 500,000 | Raw | — | Not yet measured | N/A | May jank |

### FPS (distinguish the two kinds)

| Dataset | Mode | Live / display FPS (HUD) | Mode-specific table FPS | Notes |
|---------|------|--------------------------|-------------------------|-------|
| — | — | Not yet measured | Not yet measured | Live FPS is display-limited; do not equate to “app scored 144 FPS” |

### Memory (`performance.memory`)

| Dataset | Used JS heap | Limit | Status |
|---------|--------------|-------|--------|
| — | Not yet measured | Not yet measured | Or **Unavailable** if API missing |

### What this project explicitly does **not** claim without measurement

- Sustained 144 FPS as a computational benchmark (vs display sync)
- &lt;1 MB/hour memory growth
- &lt;100 ms interaction latency SLA
- Fabricated Raw/Optimized millisecond pairs

Use the dashboard’s **Raw vs Optimized** table and Performance cards as the source of truth for any numbers you paste into the tables above.
