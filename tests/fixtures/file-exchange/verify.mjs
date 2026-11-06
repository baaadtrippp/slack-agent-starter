import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { selectEvents } from './window.ts';

function parseCsv(text) {
  return text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(',')
        .map((field) =>
          field.startsWith('"') && field.endsWith('"')
            ? field.slice(1, -1)
            : field,
        ),
    );
}

function containsPercentage(text, expected) {
  for (const [, number] of text.matchAll(/([+−-]?\s*\d+(?:\.\d+)?)\s*%/g)) {
    if (number.trim().replace(/^\+\s*/, '') === expected) return true;
  }
  return false;
}

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
const [sourceHeader, ...sourceRecords] = parseCsv(csv);
assert.deepEqual(sourceHeader, ['period', 'region', 'orders', 'revenue_cents']);

const rows = sourceRecords.map(([period, region, orders, revenueCents]) => {
  assert.match(orders.trim(), /^(?:\d+)?$/);
  assert.match(revenueCents, /^\d+$/);
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
  const [cleanedHeader, ...cleanedRecords] = parseCsv(
    await readFile(downloadedCsv, 'utf8'),
  );
  const expectedHeader = [
    'period',
    'region',
    'orders',
    'revenue_cents',
    'quality_flag',
  ];
  assert.equal(new Set(cleanedHeader).size, expectedHeader.length);
  assert.deepEqual(cleanedHeader.toSorted(), expectedHeader.toSorted());
  const cleanedIndex = Object.fromEntries(
    cleanedHeader.map((name, index) => [name, index]),
  );
  assert.deepEqual(
    cleanedRecords.map((record) => {
      assert.equal(record.length, cleanedHeader.length);
      return expectedHeader.map((name) => record[cleanedIndex[name]]);
    }),
    rows.map((row) => [
      row.period,
      row.region,
      row.orders,
      String(row.revenueCents),
      row.orders === '' ? 'missing_orders' : '',
    ]),
  );
}

const comparisonReply = process.argv[3];
if (comparisonReply)
  assert.ok(
    containsPercentage(
      await readFile(comparisonReply, 'utf8'),
      percentChange.toFixed(1),
    ),
    'Expected the positive fixture percentage in the reply',
  );

const reuseReply = process.argv[4];
if (reuseReply)
  assert.ok(
    containsPercentage(
      await readFile(reuseReply, 'utf8'),
      q2NorthShare.toFixed(1),
    ),
    'Expected the positive fixture percentage in the reply',
  );

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
      verifiedComparisonReply: Boolean(comparisonReply),
      verifiedReuseReply: Boolean(reuseReply),
    },
  }),
);
