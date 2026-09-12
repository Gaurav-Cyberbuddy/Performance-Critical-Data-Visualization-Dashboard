'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  onFps?: (fps: number) => void;
}

// Live FPS counter using requestAnimationFrame, so the assignment's claim
// of "performance-critical" is actually measurable on screen rather than
// asserted in a README.
export function PerfHUD({ onFps }: Props) {
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  const lastTime = useRef(0);
  const onFpsRef = useRef(onFps);

  useEffect(() => {
    onFpsRef.current = onFps;
  }, [onFps]);

  useEffect(() => {
    let raf: number;
    lastTime.current = performance.now();
    const tick = () => {
      frames.current++;
      const now = performance.now();
      if (now - lastTime.current >= 500) {
        const next = Math.round((frames.current * 1000) / (now - lastTime.current));
        setFps(next);
        onFpsRef.current?.(next);
        frames.current = 0;
        lastTime.current = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const color = fps >= 50 ? '#22c55e' : fps >= 30 ? '#eab308' : fps > 0 ? '#ef4444' : '#6b7280';

  return (
    <div className="perf-hud" title="Measured via requestAnimationFrame; capped by display refresh rate">
      <span className="perf-dot" style={{ background: color }} />
      Live FPS {fps || '—'}
    </div>
  );
}
