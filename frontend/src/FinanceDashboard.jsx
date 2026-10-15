import { useMemo } from 'react';

const money = (value) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(Number(value || 0));
const shortMoney = (value) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(value || 0));
const dateLabel = (value) => value ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium' }).format(new Date(value)) : '—';

function Metric({ label, value, caption, icon, tone = 'blue' }) {
  return <article className="finance-metric"><div className="finance-metric-top"><span>{label}</span><span className={'finance-metric-icon ' + tone}>{icon}</span></div><strong>{value}</strong><small>{caption}</small></article>;
}

function SectionHeading({ title, subtitle, action }) {
  return <div className="finance-section-heading"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}

function downloadFinanceCsv(rows) {
  const columns = [
    ['Filiale', row => row.name], ['Dispositivi', row => row.count], ['Device NOL', row => row.nolCount],
    ['Costo hardware NOL', row => row.investment], ['Canoni mensili NOL', row => row.monthly]
  ];
  const quote = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const csv = [columns.map(([label]) => quote(label)).join(';'), ...rows.map(row => columns.map(([, get]) => quote(get(row))).join(';'))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'finance-filiali.csv'; link.click(); URL.revokeObjectURL(url);
}

export default function FinanceDashboard({ finance, branches = [], devices = [], branchFilter = 'all' }) {
  const branchRows = useMemo(() => {
    const grouped = new Map();
    for (const device of devices) {
      if (!device.branch_id) continue;
      const key = String(device.branch_id);
      const row = grouped.get(key) || {
        id: key,
        name: [device.company_name, device.branch_nomenclature || device.branch_name || device.branch_street].filter(Boolean).join(' · ') || ('Filiale #' + key),
        count: 0, nolCount: 0, investment: 0, monthly: 0, faults: 0
      };
      row.count += 1;
      if (device.ownership_type === 'rental') {
        row.nolCount += 1;
        row.investment += Number(device.purchase_cost || 0);
        row.monthly += Number(device.monthly_fee || 0);
      }
      if (device.status === 'fault') row.faults += 1;
      grouped.set(key, row);
    }
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, 'it'));
  }, [devices]);

  const allNolInvestment = useMemo(() => devices.filter(d => d.ownership_type === 'rental').reduce((sum, d) => sum + Number(d.purchase_cost || 0), 0), [devices]);
  const activeNolMonthly = Number(finance?.nol_current_month || 0);
  const revenueAllTime = Number(finance?.nol_all_time || 0);
  const costs = Number(finance?.total_costs || 0);
  const margin = Number(finance?.overall_margin || 0);
  const selectedBranch = branchFilter === 'all' ? null : branches.find(b => String(b.id) === String(branchFilter));
  const selectedLabel = selectedBranch ? [selectedBranch.company_name, selectedBranch.nomenclature || selectedBranch.street].filter(Boolean).join(' · ') : 'Tutte le filiali';
  const faultCount = devices.filter(d => d.status === 'fault').length;
  const stockCount = devices.filter(d => d.status === 'in_stock').length;
  const maxInvestment = Math.max(1, ...branchRows.map(row => row.investment));
  const maxMonthly = Math.max(1, ...branchRows.map(row => row.monthly));

  return <section className="page-content finance-dashboard">
    <div className="page-intro finance-page-intro">
      <div><p className="eyebrow">PANORAMICA ECONOMICA</p><h2>Finance</h2><p className="muted">Investimenti, ricavi NOL, margini e costi operativi del parco device.</p></div>
      <div className="finance-intro-actions"><span className="soft-tag">{selectedLabel}</span><button className="secondary-button" onClick={() => downloadFinanceCsv(branchRows)}>Esporta riepilogo</button></div>
    </div>

    <div className="finance-metrics-grid">
      <Metric label="NOL · mese corrente" value={money(finance?.nol_current_month)} caption="Canoni maturati nel mese" icon="↻" tone="green" />
      <Metric label="NOL · totale storico" value={money(revenueAllTime)} caption="Ricavi NOL maturati" icon="€" tone="violet" />
      <Metric label="Investimento device NOL" value={money(allNolInvestment)} caption="Costo registrato dei device NOL visibili" icon="▣" tone="blue" />
      <Metric label="Costi complessivi" value={money(costs)} caption="Hardware, licenze e altri costi registrati" icon="↘" tone="amber" />
      <Metric label="Margine complessivo" value={money(margin)} caption="Ricavi e canoni meno costi registrati" icon="↗" tone={margin >= 0 ? 'green' : 'red'} />
      <Metric label="Device in stato guasto" value={String(faultCount)} caption="Apparati da gestire" icon="!" tone={faultCount ? 'red' : 'green'} />
    </div>

    <div className="finance-dashboard-grid">
      <section className="panel finance-panel">
        <SectionHeading title="Riepilogo per filiale" subtitle="Investimento NOL e canoni mensili per le filiali con device assegnati." action={<button className="text-button" onClick={() => downloadFinanceCsv(branchRows)}>Esporta CSV →</button>} />
        {branchRows.length ? <div className="table-panel finance-nested-table"><table><thead><tr><th>Filiale</th><th>Device</th><th>Device NOL</th><th>Investimento NOL</th><th>Canoni mensili</th><th>Guasti aperti</th></tr></thead><tbody>{branchRows.map(row => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{row.count}</td><td>{row.nolCount}</td><td>{money(row.investment)}</td><td>{money(row.monthly)}</td><td><span className={'finance-fault-count ' + (row.faults ? 'has-faults' : '')}>{row.faults}</span></td></tr>)}</tbody><tfoot><tr><th>Totale visibile</th><th>{branchRows.reduce((sum, r) => sum + r.count, 0)}</th><th>{branchRows.reduce((sum, r) => sum + r.nolCount, 0)}</th><th>{money(branchRows.reduce((sum, r) => sum + r.investment, 0))}</th><th>{money(branchRows.reduce((sum, r) => sum + r.monthly, 0))}</th><th>{branchRows.reduce((sum, r) => sum + r.faults, 0)}</th></tr></tfoot></table></div> : <div className="finance-empty"><strong>Nessun dato per questa selezione</strong><span>Assegna un device a una filiale per visualizzarlo qui.</span></div>}
      </section>

      <section className="panel finance-panel">
        <SectionHeading title="Andamento economico" subtitle="Indicatori disponibili dal servizio Finance." />
        <div className="finance-bars">
          <div className="finance-bar-row"><div><span>Ricavi NOL storici</span><strong>{money(revenueAllTime)}</strong></div><div className="finance-bar-track"><span className="green" style={{ width: Math.min(100, revenueAllTime / Math.max(revenueAllTime, costs, allNolInvestment, 1) * 100) + '%' }} /></div></div>
          <div className="finance-bar-row"><div><span>Costi registrati</span><strong>{money(costs)}</strong></div><div className="finance-bar-track"><span className="amber" style={{ width: Math.min(100, costs / Math.max(revenueAllTime, costs, allNolInvestment, 1) * 100) + '%' }} /></div></div>
          <div className="finance-bar-row"><div><span>Investimento device NOL visibile</span><strong>{money(allNolInvestment)}</strong></div><div className="finance-bar-track"><span className="blue" style={{ width: Math.min(100, allNolInvestment / Math.max(revenueAllTime, costs, allNolInvestment, 1) * 100) + '%' }} /></div></div>
        </div>
        <div className="finance-balance-card"><span>Saldo NOL calcolato dal backend</span><strong className={Number(finance?.nol_balance || 0) >= 0 ? 'positive' : 'negative'}>{money(finance?.nol_balance)}</strong><small>Non include ancora eventuali costi guasti non registrati nel sistema.</small></div>
      </section>
    </div>

    <div className="finance-lower-grid">
      <section className="panel finance-panel">
        <SectionHeading title="Composizione del parco" subtitle="Stato dei device attualmente caricati." />
        <div className="finance-status-list">
          <div><span className="finance-status-dot green" /><span>Operativi</span><strong>{devices.filter(d => d.status === 'operational').length}</strong></div>
          <div><span className="finance-status-dot amber" /><span>In magazzino</span><strong>{stockCount}</strong></div>
          <div><span className="finance-status-dot red" /><span>Guasti</span><strong>{faultCount}</strong></div>
          <div><span className="finance-status-dot blue" /><span>Da attivare</span><strong>{devices.filter(d => d.status === 'to_activate').length}</strong></div>
        </div>
        <div className="finance-status-footer"><span>Device censiti nella selezione</span><strong>{devices.length}</strong></div>
      </section>

      <section className="panel finance-panel finance-fault-panel">
        <SectionHeading title="Guasti e sostituzioni" subtitle="Costi aggiuntivi attribuiti alla filiale." />
        <div className="finance-fault-notice"><span className="finance-fault-icon">!</span><div><strong>Tracciamento costi guasti da integrare</strong><p>Il portale non registra ancora gli eventi RMA/SCI e i relativi costi in una fonte strutturata. Per evitare dati inventati, il contatore finanziario sarà valorizzato quando il flusso guasti sarà implementato.</p></div></div>
        <div className="finance-fault-summary"><div><span>Device attualmente guasti</span><strong>{faultCount}</strong></div><div><span>Costi aggiuntivi contabilizzati</span><strong>—</strong></div></div>
      </section>
    </div>

    <section className="panel finance-panel finance-device-detail">
      <SectionHeading title={selectedBranch ? 'Dettaglio device · ' + selectedLabel : 'Dettaglio device NOL'} subtitle="Costi e canoni dei dispositivi attualmente visibili nel filtro globale." />
      <div className="table-panel finance-nested-table"><table><thead><tr><th>Dispositivo</th><th>Filiale</th><th>Stato</th><th>Attivazione</th><th>Canone NOL</th><th>Costo registrato</th></tr></thead><tbody>{devices.filter(d => d.ownership_type === 'rental').slice(0, 30).map(device => <tr key={device.id}><td><strong>{[device.manufacturer, device.model_name, device.serial_number].filter(Boolean).join(' · ') || ('Device #' + device.id)}</strong></td><td>{device.branch_nomenclature || device.branch_name || '—'}</td><td><span className={'finance-device-state ' + (device.status === 'operational' ? 'operational' : device.status === 'fault' ? 'fault' : '')}>{device.status === 'operational' ? 'Operativo' : device.status === 'fault' ? 'Guasto' : device.status === 'in_stock' ? 'In magazzino' : device.status === 'to_activate' ? 'Da attivare' : device.status}</span></td><td>{dateLabel(device.activated_on || device.installed_on)}</td><td>{money(device.monthly_fee)}</td><td>{money(device.purchase_cost)}</td></tr>)}</tbody></table>{!devices.some(d => d.ownership_type === 'rental') && <div className="finance-empty"><strong>Nessun device NOL nella selezione</strong><span>Modifica il filtro filiale o verifica le assegnazioni.</span></div>}</div>
    </section>
  </section>;
}
