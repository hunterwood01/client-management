export function calculateLicenseFinanceMetrics({ investment, monthlyTimeline, currentMonth }) {
  const totalInvestment = Math.max(0, Number(investment) || 0);
  const timeline = [...monthlyTimeline].sort((a, b) => a.month.localeCompare(b.month));
  const currentRow = timeline.find((row) => row.month === currentMonth);
  const currentMonthlyRevenue = Number(currentRow?.monthly_revenue) || 0;

  let recovered = 0;
  let projectedRevenue = 0;
  let cumulativeRevenue = 0;
  let breakEvenDate = null;

  for (const row of timeline) {
    const actualRevenue = Number(row.monthly_revenue) || 0;
    const isPast = row.month < currentMonth;
    const forecastRevenue = isPast ? actualRevenue : currentMonthlyRevenue;

    if (row.month <= currentMonth) recovered += actualRevenue;
    projectedRevenue += isPast ? actualRevenue : forecastRevenue;
    cumulativeRevenue += forecastRevenue;

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
