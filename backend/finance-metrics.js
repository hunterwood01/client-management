export function calculateLicenseFinanceMetrics({ investment, monthlyTimeline, currentMonth }) {
  const totalInvestment = Math.max(0, Number(investment) || 0);
  let recovered = 0;
  let projectedRevenue = 0;
  let cumulativeRevenue = 0;
  let breakEvenDate = null;

  for (const row of monthlyTimeline) {
    const revenue = Number(row.monthly_revenue) || 0;
    if (row.month <= currentMonth) recovered += revenue;
    projectedRevenue += revenue;
    cumulativeRevenue += revenue;

    if (!breakEvenDate && totalInvestment > 0 && cumulativeRevenue >= totalInvestment) {
      const [year, month] = row.month.split('-').map(Number);
      breakEvenDate = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    }
  }

  return {
    recovered,
    amountToRecover: Math.max(0, totalInvestment - recovered),
    recoveryPercent: totalInvestment > 0
      ? Math.max(0, Math.min(100, recovered / totalInvestment * 100))
      : null,
    projectedRevenue,
    projectedMargin: projectedRevenue - totalInvestment,
    breakEvenDate
  };
}
