import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLicenseFinanceMetrics } from './finance-metrics.js';

test('includes current month in recovered revenue and calculates projected margin', () => {
  const result = calculateLicenseFinanceMetrics({
    investment: 1000,
    currentMonth: '2026-10-01',
    monthlyTimeline: [
      { month: '2026-09-01', monthly_revenue: 200 },
      { month: '2026-10-01', monthly_revenue: 300 },
      { month: '2026-11-01', monthly_revenue: 600 }
    ]
  });
  assert.equal(result.recovered, 500);
  assert.equal(result.amountToRecover, 500);
  assert.equal(result.recoveryPercent, 50);
  assert.equal(result.projectedRevenue, 1100);
  assert.equal(result.projectedMargin, 100);
  assert.equal(result.breakEvenDate, '2026-12-01');
});

test('returns no break-even date when projected revenue never reaches investment', () => {
  const result = calculateLicenseFinanceMetrics({
    investment: 1000,
    currentMonth: '2026-10-01',
    monthlyTimeline: [
      { month: '2026-10-01', monthly_revenue: 100 },
      { month: '2026-11-01', monthly_revenue: 200 }
    ]
  });
  assert.equal(result.projectedMargin, -700);
  assert.equal(result.breakEvenDate, null);
});

test('handles zero investment without division by zero', () => {
  const result = calculateLicenseFinanceMetrics({
    investment: 0,
    currentMonth: '2026-10-01',
    monthlyTimeline: [{ month: '2026-10-01', monthly_revenue: 250 }]
  });
  assert.equal(result.recovered, 250);
  assert.equal(result.amountToRecover, 0);
  assert.equal(result.recoveryPercent, null);
  assert.equal(result.projectedMargin, 250);
  assert.equal(result.breakEvenDate, null);
});

test('does not count future months as recovered to date', () => {
  const result = calculateLicenseFinanceMetrics({
    investment: 500,
    currentMonth: '2026-10-01',
    monthlyTimeline: [
      { month: '2026-10-01', monthly_revenue: 200 },
      { month: '2026-11-01', monthly_revenue: 400 }
    ]
  });
  assert.equal(result.recovered, 200);
  assert.equal(result.amountToRecover, 300);
  assert.equal(result.breakEvenDate, '2026-12-01');
});
