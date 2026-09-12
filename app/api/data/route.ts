import { NextResponse } from 'next/server';
import { generateDataset } from '@/lib/dataGenerator';

/**
 * Small sample API for Next.js routing demos.
 * Full 500K-point generation stays in the browser — this route intentionally
 * returns only a tiny payload so server round-trips are not part of the
 * performance demonstration.
 */
export async function GET() {
  const sample = generateDataset(100);
  return NextResponse.json({
    count: sample.length,
    sample: sample.slice(0, 20),
    note: 'Sample payload only. Full datasets are generated and processed in the browser.',
  });
}
