'use client';

import { useRef, useState, useMemo, useCallback, useEffect, type UIEvent } from 'react';
import type { DataPoint } from '@/lib/dataGenerator';

interface Props {
  data: DataPoint[];
  rowHeight?: number;
  height?: number;
}

// Renders only the rows currently in the scroll viewport (+ overscan),
// regardless of whether `data` has 1,000 or 1,000,000 rows. The DOM node
// count stays constant, which is what keeps scroll performance flat.
export function VirtualTable({ data, rowHeight = 36, height = 420 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // If the data array shrinks (e.g. category filter narrows 500k rows down
  // to ~125k) while scrolled deep in, the old scrollTop can point past the
  // new array's end — startIndex/endIndex would clamp to an empty slice and
  // the table would render blank until the user manually scrolled back up.
  // Reset to the top whenever the underlying data reference changes.
  useEffect(() => {
    setScrollTop(0);
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [data]);

  const overscan = 8;
  const totalHeight = data.length * rowHeight;

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(height / rowHeight) + overscan * 2;
  const endIndex = Math.min(data.length, startIndex + visibleCount);

  const visibleRows = useMemo(
    () => data.slice(startIndex, endIndex),
    [data, startIndex, endIndex]
  );

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  if (data.length === 0) {
    return (
      <div className="vtable-wrapper vtable-empty">
        <p>No rows match the current filter.</p>
      </div>
    );
  }

  return (
    <div className="vtable-wrapper">
      <div className="vtable-header-row">
        <span>Timestamp</span>
        <span>Category</span>
        <span className="col-num">Value</span>
        <span className="col-num">Volume</span>
      </div>
      <div
        ref={containerRef}
        className="vtable-scroll"
        style={{ height }}
        onScroll={onScroll}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          {visibleRows.map((row, i) => {
            const actualIndex = startIndex + i;
            return (
              <div
                key={actualIndex}
                className="vtable-row"
                style={{
                  position: 'absolute',
                  top: actualIndex * rowHeight,
                  height: rowHeight,
                  left: 0,
                  right: 0,
                }}
              >
                <span className="col-time">{new Date(row.timestamp).toLocaleTimeString('en-US')}</span>
                <span className={`badge badge-${row.category.replace(/\s|\//g, '')}`}>
                  {row.category}
                </span>
                <span className="col-num">{row.value.toFixed(2)}</span>
                <span className="col-num">{row.volume.toLocaleString('en-US')}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="vtable-footer">
        Showing rows {startIndex + 1}–{endIndex} of {data.length.toLocaleString('en-US')} ·{' '}
        {visibleRows.length} DOM rows mounted (virtualized)
      </div>
    </div>
  );
}
