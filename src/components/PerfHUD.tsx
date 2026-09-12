import { useEffect, useRef, useState } from 'react';

// Live FPS counter using requestAnimationFrame, so the assignment's claim
// of "performance-critical" is actually measurable on screen rather than
// asserted in a README.
export function PerfHUD() {
  const [fps, setFps] = useState(60);
  const frames = useRef(0);
  const lastTime = useRef(performance.now());

  useEffect(() => {
    let raf: number;
    const tick = () => {
      frames.current++;
      const now = performance.now();
      if (now - lastTime.current >= 500) {
        setFps(Math.round((frames.current * 1000) / (now - lastTime.current)));
        frames.current = 0;
        lastTime.current = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const color = fps >= 50 ? '#22c55e' : fps >= 30 ? '#eab308' : '#ef4444';

  return (
    <div className="perf-hud">
      <span className="perf-dot" style={{ background: color }} />
      {fps} FPS
    </div>
  );
}
