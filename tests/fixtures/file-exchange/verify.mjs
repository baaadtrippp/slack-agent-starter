import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { selectEvents } from './window.ts';

const events = [
  { id: 'start', atMs: 100 },
  { id: 'middle', atMs: 150 },
  { id: 'end', atMs: 200 },
];
const expectedHalfOpenIds = ['start', 'middle'];
const patchedIds = selectEvents(events, 100, 200).map((event) => event.id);

assert.deepEqual(patchedIds, ['middle', 'end']);
assert.notDeepEqual(patchedIds, expectedHalfOpenIds);

const csv = await readFile(
  new URL('./regional-revenue.csv', import.meta.url),
  'utf8',
);
const [header, ...lines] = csv.trimEnd().split('\n');
assert.equal(header, 'period,region,orders,revenue_cents');

const rows = lines.map((line) => {
  const [period, region, orders, revenueCents] = line.split(',');
  return {
    period: period.trim(),
    region: region.trim(),
    orders: orders.trim(),
    revenueCents: Number.parseInt(revenueCents, 10),
  };
});

const totals = new Map();
for (const row of rows) {
  totals.set(row.period, (totals.get(row.period) ?? 0) + row.revenueCents);
}

assert.equal(totals.get('2026-Q1'), 28_200);
assert.equal(totals.get('2026-Q2'), 32_600);

const difference = totals.get('2026-Q2') - totals.get('2026-Q1');
const percentChange = Number(
  ((difference / totals.get('2026-Q1')) * 100).toFixed(1),
);
const q2North = rows.find(
  (row) => row.period === '2026-Q2' && row.region === 'North',
);
const q2NorthShare = Number(
  ((q2North.revenueCents / totals.get('2026-Q2')) * 100).toFixed(1),
);

assert.equal(difference, 4_400);
assert.equal(percentChange, 15.6);
assert.equal(q2NorthShare, 46.0);
assert.deepEqual(
  rows.filter((row) => row.orders === '').map((row) => row.region),
  ['West'],
);

const downloadedCsv = process.argv[2];
if (downloadedCsv) {
  const cleaned = (await readFile(downloadedCsv, 'utf8'))
    .trimEnd()
    .split(/\r?\n/);
  assert.equal(
    cleaned.shift(),
    'period,region,orders,revenue_cents,quality_flag',
  );
  assert.deepEqual(
    cleaned,
    rows.map((row) =>
      [
        row.period,
        row.region,
        row.orders,
        row.revenueCents,
        row.orders === '' ? 'missing_orders' : '',
      ].join(','),
    ),
  );
}

console.log(
  JSON.stringify({
    patchReview: {
      expectedHalfOpenIds,
      patchedIds,
    },
    csvAnalysis: {
      q1RevenueCents: totals.get('2026-Q1'),
      q2RevenueCents: totals.get('2026-Q2'),
      differenceCents: difference,
      percentChange,
      q2NorthShare,
      missingOrdersRegion: 'West',
      verifiedDownload: Boolean(downloadedCsv),
    },
  }),
);
