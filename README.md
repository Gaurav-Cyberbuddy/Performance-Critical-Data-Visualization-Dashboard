# Performance-Critical Data Visualization Dashboard

A frontend R&D exercise in rendering large multi-series time-series datasets
(up to 500,000 points) in the browser without dropping frames, using no
charting library.

## Live features

- Dataset size selector (10k → 500k synthetic points, random-walk generated)
- Four independent series (CPU / Memory / Network / Disk I/O), each rendered
  as its own line with its own color and legend entry
- Category filter (view one series or all four overlaid) + text filter on the table
- **Raw vs Optimized toggle** — Raw skips the Web Worker/LTTB pipeline entirely and
  hands the chart the full per-category dataset directly; Optimized runs the normal
  worker → LTTB → canvas pipeline. Both are timed with `performance.now()` around
  the actual draw call, and once you've viewed both modes a comparison card shows
  the real measured render time and the speedup multiplier — no numbers are
  hardcoded or estimated. A visible warning appears in Raw mode above ~100k points
  since it can genuinely affect responsiveness on slower devices
- A hand-rolled Canvas2D multi-line chart with a per-series hover tooltip
- A virtualized data table that scrolls smoothly regardless of row count
- A live FPS counter (top-right) and per-stage timing (generation, downsample) so
  the performance claims are measurable, not asserted

## Key architectural decisions

### 1. Per-category typed arrays, not one flat sorted array (`src/lib/dataGenerator.ts`)
**This fixes a real bug caught during review.** The dataset generator originally
produced all four categories, then sorted the *entire* array by timestamp. All
categories share the same timestamp range, so the sorted array ends up
interleaving CPU/Memory/Network/Disk points almost every step. Charting "All
categories" straight from that array draws one line that zig-zags between
unrelated series — it looks like a single noisy signal instead of four
distinct system metrics.

The fix: `groupByCategoryTyped()` splits the flat array into one
`{timestamps: Float64Array, values: Float64Array}` pair per category. The
chart, the worker requests, and Raw mode are all built from this grouped
structure, so each category is always its own line.

### 2. LTTB downsampling, per series (`src/lib/lttb.ts`)
A chart panel is typically 800–1400px wide, so it can't usefully display more than
~1,000–1,400 distinct x-positions per line no matter how much data you feed it.
Rather than sampling every Nth point (which can silently erase spikes/anomalies —
exactly the data an ops dashboard most needs to show), this uses the
**Largest-Triangle-Three-Buckets** algorithm, which picks the point in each bucket
that best preserves the visual shape of the line. Each category's ~125,000 points
become ~400 points (fewer per-series when 4 lines are overlaid, ~1,200 when
viewing a single category) that still show every spike.

### 3. Typed arrays + transferable buffers to the Web Worker (`src/workers/dataWorker.ts`)
The first version sent the full `DataPoint[]` (objects with `timestamp`, `value`,
a repeated `category` string, and `volume`) to the worker on every request, where
it was structured-cloned — copied element by element, including the redundant
strings, across the thread boundary.

This version sends only `Float64Array` pairs, and moves them via postMessage's
**transfer list** rather than structured clone — ownership of the underlying
buffer hops to the worker as an O(1) pointer move instead of a copy. The main
thread keeps the canonical typed arrays (via `.slice()` before transfer) so
Raw mode and the table still have the original data available. The worker
downsamples and transfers the *result* back the same way.

### 4. Canvas2D instead of SVG or a chart library
SVG renders each point as a DOM node — at even a few thousand points this creates real
GC and layout pressure. Canvas is a single bitmap the browser composites once per frame,
so render cost is dictated by the (small, downsampled) point count, not the raw dataset
size. Each series is one `stroke()` call — 4 series overlaid is still just 4 draw calls.

### 5. Virtualized table (`src/components/VirtualTable.tsx`)
Only rows inside (plus a small overscan around) the visible scroll viewport are mounted
in the DOM — the DOM node count is constant whether the table has 1,000 or 500,000 rows.
Scroll position maps directly to a slice index, so there's no dependency on a table
library.

### 6. Raw vs Optimized comparison (`src/App.tsx`)
This is the piece that turns "I optimized this" into a measured claim. Toggling to
Raw bypasses the worker and LTTB entirely and asks Canvas to draw every point per
category directly; toggling to Optimized runs the normal pipeline. Both paths report
their real `performance.now()` render duration through the same callback, and the app
shows both numbers plus the resulting speedup once you've triggered each mode once.
Switching dataset size or category clears the stored measurements so the comparison
never mixes numbers from two different runs. Above ~100k raw points a visible warning
is shown, since drawing that many points with no downsampling can genuinely affect
responsiveness on slower machines — the toggle is meant to demonstrate the cost, not
hide it.

One correctness bug worth mentioning in an interview: the chart's min/max calculation
originally used `Math.min(...points.map(...))`, which spreads the array into function
arguments — V8 overflows the call stack around ~65k arguments. That's invisible in
Optimized mode (only a few hundred points per series ever reach it) but breaks
immediately in Raw mode at 100k+ points. Fixed by computing min/max in a single loop
instead, across all series' typed arrays.

### 7. Everything is measured, not assumed
The stats row shows real generation time and worker round-trip time; the FPS HUD proves
the UI thread stays responsive. Swap "Dataset size" to 500,000 and watch FPS stay flat —
that's the actual R&D result this exercise is meant to demonstrate.

## Stack

- React 19 + TypeScript + Vite
- Zero chart/virtualization dependencies — Canvas2D, LTTB, and windowing are
  implemented directly to keep the surface area small and every performance
  decision visible/explainable

## Running it

```bash
npm install
npm run dev      # local dev server
npm run build    # production build → dist/
```

## Possible extensions (noted, not built, for time reasons)
- Pan/zoom on the chart with re-downsampling per visible time range
- IndexedDB-backed dataset for >1M point stress testing without regenerating each time
- OffscreenCanvas + rendering inside the worker itself, for an even more isolated pipeline
- Cap Raw mode's point count at extreme dataset sizes instead of only warning
