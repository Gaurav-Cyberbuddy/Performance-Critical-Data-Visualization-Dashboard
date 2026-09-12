import type { Metadata } from 'next';
import '../styles/globals-base.css';
import '../styles/dashboard.css';

export const metadata: Metadata = {
  title: 'Performance-Critical Data Visualization Dashboard',
  description:
    'Browser-side Canvas2D charting with Web Workers, LTTB downsampling, and virtualized tables.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
