import { useCallback, useEffect, useMemo, useState } from 'react';

const navigation = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦' },
  { id: 'branches', label: 'Filiali', icon: '⌂' },
  { id: 'devices', label: 'Device', icon: '▣' },
  { id: 'finance', label: 'Finance', icon: '€' },
  { id: 'warehouse', label: 'Magazzino', icon: '▤' },
  { id: 'admin', label: 'Amministrazione', icon: '⚙' }
];

const emptyBranch = {
  company_id: '', country: 'Italia', street: '', nomenclature: '',
  previous_nomenclature: '', network: '', phone_prefix: '', wlc: '', is_active: '', active_since: ''
};

async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
    throw new Error(payload.error || 'Richiesta non riuscita.');
  }
  return payload;
}

function money(value) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(Number(value || 0));
}

function date(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium' }).format(new Date(value));
}

function downloadCsv(filename, columns, rows) {
  const quote = (value) => {
    let text = String(value ?? '');
    if (/^[=+@\\-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const csv = [columns.map((column) => quote(column.label)).join(';'),
    ...rows.map((row) => columns.map((column) => quote(column.value(row))).join(';'))].join('\\r\\n');
  const blob = new Blob(['\\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

function parseDeviceCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('Il CSV non contiene righe dispositivo.');
  const delimiterCount = (line, delimiter) => {
    let quoted = false, count = 0;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"' && line[i + 1] === '"' && quoted) i += 1;
      else if (line[i] === '"') quoted = !quoted;
      else if (line[i] === delimiter && !quoted) count += 1;
    }
    return count;
  };
  const delimiter = [';', '\\t', ','].sort((a, b) => delimiterCount(lines[0], b) - delimiterCount(lines[0], a))[0];
  const parseLine = (line) => {
    const cells = []; let value = '', quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"' && quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === delimiter && !quoted) { cells.push(value.trim()); value = ''; }
      else value += ch;
    }
    cells.push(value.trim()); return cells;
  };
  const headers = parseLine(lines[0]).map((value) => normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim());
  const index = (...names) => headers.findIndex((header) => names.includes(header));
  const indexes = {
    serial: index('serial', 'matricola', 'seriale'),
    sku: index('sku', 'codice sku'),
    model: index('model', 'modello', 'dispositivo'),
    brand: index('brand', 'marca', 'manufacturer'),
    type: index('type', 'tipologia'),
    company: index('ragione sociale', 'company', 'azienda'),
    branch: index('branch', 'filiale', 'nome filiale', 'sede'),
    contract: index('contracttype', 'contract type', 'contratto', 'formula'),
    status: index('status', 'stato'),
    cost: index('purchasecost', 'purchase cost', 'costo acquisto'),
    fee: index('monthlyfee', 'monthly fee', 'canone mensile'),
    activation: index('activationdate', 'activation date', 'data attivazione'),
    notes: index('notes', 'note'),
    location: index('stocklocation', 'stock location', 'magazzino', 'magazzino di provenienza')
  };
  if (indexes.model < 0 && indexes.sku < 0) throw new Error('Il CSV deve contenere almeno una colonna SKU o Modello.');
  if (indexes.branch < 0) throw new Error('Il CSV deve contenere la colonna Filiale.');
  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseLine(line);
    const value = (key) => indexes[key] < 0 ? '' : String(cells[indexes[key]] || '').trim();
    return {
      rowNumber: rowIndex + 2, serial: value('serial'), sku: value('sku'),
      modelName: value('model') || value('type'), brand: value('brand'),
      companyName: value('company'), branchName: value('branch'),
      contract: value('contract').toUpperCase(), statusText: value('status'),
      purchaseCost: value('cost'), monthlyFee: value('fee'), activationDate: value('activation'),
      notes: value('notes'), stockLocationName: value('location')
    };
  }).filter((row) => row.sku || row.modelName || row.serial);
}

function initials(name) {
  return String(name || 'Utente').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function normalizeText(value) {
  return String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('it');
}

function parseNetworkCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('Il CSV NETWORK non contiene righe da importare.');
  const countDelimiter = (line, delimiter) => {
    let quoted = false, count = 0;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"' && line[i + 1] === '"' && quoted) i += 1;
      else if (line[i] === '"') quoted = !quoted;
      else if (line[i] === delimiter && !quoted) count += 1;
    }
    return count;
  };
  const delimiter = [';', '\t', ','].sort((a, b) => countDelimiter(lines[0], b) - countDelimiter(lines[0], a))[0];
  const parseLine = (line) => {
    const cells = []; let value = '', quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"' && quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === delimiter && !quoted) { cells.push(value.trim()); value = ''; }
      else value += ch;
    }
    cells.push(value.trim());
    return cells;
  };
  const firstCells = parseLine(lines[0]);
  const headerKey = (value) => normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim();
  const headers = firstCells.map(headerKey);
  const find = (...names) => headers.findIndex((header) => names.includes(header));
  const companyIndex = find('ragione sociale', 'company', 'azienda');
  const branchIndex = find('nome filiale', 'filiale', 'branch', 'sede');
  const hasHeader = companyIndex >= 0 && branchIndex >= 0;
  const rows = hasHeader ? lines.slice(1).map(parseLine) : lines.map(parseLine);
  const indexes = hasHeader ? {
    company: companyIndex, branch: branchIndex,
    prefix: find('prefisso', 'prefisso telefonico', 'phone prefix', 'prefix'),
    lan: find('network lan', 'lan', 'rete lan'),
    wlc: find('wlc', 'wireless lan controller'),
    oldName: find('vecchio nome', 'old name', 'previous nomenclature'),
    newName: find('nuovo nome', 'new name', 'nomenclatura')
  } : { company: -1, branch: 0, prefix: 1, lan: 2, wlc: 5, oldName: 7, newName: -1 };
  return rows.map((cells, index) => {
    const value = (column) => column >= 0 ? String(cells[column] || '').trim() : '';
    const combined = value(indexes.branch);
    const companyName = value(indexes.company);
    if (!combined || normalizeText(combined).includes('network 4g vodafone')) return null;
    return {
      combined, companyName, branchName: combined, prefix: value(indexes.prefix), lan: value(indexes.lan),
      wlc: value(indexes.wlc), oldName: value(indexes.oldName), newName: value(indexes.newName),
      rowNumber: index + (hasHeader ? 2 : 1)
    };
  }).filter(Boolean);
}

function splitNetworkBranch(combined, companyNames) {
  const value = String(combined || '').trim();
  const normalized = normalizeText(value);
  const matchingCompany = [...companyNames].sort((a, b) => b.length - a.length).find((name) => normalized.startsWith(normalizeText(name) + ' - '));
  if (matchingCompany) return { companyName: matchingCompany, branchName: value.slice(matchingCompany.length).replace(/^\s+-\s+/, '').trim() };
  const separator = value.lastIndexOf(' - ');
  if (separator > 0) return { companyName: value.slice(0, separator).trim(), branchName: value.slice(separator + 3).trim() };
  throw new Error('Impossibile separare ragione sociale e nome filiale nella voce: ' + value);
}

function ErrorNotice({ message, onClose }) {
  if (!message) return null;
  return <div className="notice notice-error" role="alert"><span>{message}</span><button className="icon-button" onClick={onClose} aria-label="Chiudi">×</button></div>;
}

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      onLogin(result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-mark">CM</div>
        <p className="eyebrow">WORKSPACE AZIENDALE</p>
        <h1>Benvenuto.</h1>
        <p className="muted">Accedi alla piattaforma per gestire filiali, dispositivi e costi.</p>
        <ErrorNotice message={error} onClose={() => setError('')} />
        <form className="form-stack login-form" onSubmit={submit}>
          <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          <button className="primary-button full-button" disabled={busy}>{busy ? 'Accesso in corso…' : 'Accedi'} <span>→</span></button>
        </form>
        <p className="login-footnote">Accesso riservato agli utenti autorizzati.</p>
      </section>
      <aside className="login-art">
        <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
        <div className="art-copy"><span className="art-kicker">CLIENT MANAGEMENT</span><h2>Tutto il tuo ambiente.<br />In un unico posto.</h2><p>Una visione chiara di sedi, apparati e attività operative.</p></div>
        <div className="art-footer"><span>Workspace</span><span>Multi-device · Responsive</span></div>
      </aside>
    </main>
  );
}

function StatCard({ label, value, caption, icon, tone = 'blue' }) {
  return <article className="stat-card"><div className={'stat-icon ' + tone}>{icon}</div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-caption">{caption}</div></article>;
}

function EmptyState({ icon = '⌕', title, description }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{description}</p></div>;
}

function Modal({ title, subtitle, onClose, children }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Chiudi">×</button></header>{children}</section></div>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [page, setPage] = useState('dashboard');
  const [theme, setTheme] = useState(() => localStorage.getItem('cm-theme') || 'light');
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [branchFilter, setBranchFilter] = useState('all');
  const [branches, setBranches] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [devices, setDevices] = useState([]);
  const [deviceImportRows, setDeviceImportRows] = useState([]);
  const [bulkBranchIds, setBulkBranchIds] = useState([]);
  const [bulkField, setBulkField] = useState('status');
  const [bulkValue, setBulkValue] = useState('to_activate');
  const [bulkDevices, setBulkDevices] = useState([]);
  const [models, setModels] = useState([]);
  const [purchaseProfiles, setPurchaseProfiles] = useState([]);
  const [locations, setLocations] = useState([]);
  const [productStock, setProductStock] = useState([]);
  const [movements, setMovements] = useState([]);
  const [users, setUsers] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [finance, setFinance] = useState(null);
  const [selectedBranch, setSelectedBranch] = useState(null);
  const [branchTab, setBranchTab] = useState('details');
  const [companyHistory, setCompanyHistory] = useState([]);
  const [checklists, setChecklists] = useState([]);
  const [adminTab, setAdminTab] = useState('companies');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [branchForm, setBranchForm] = useState(emptyBranch);
  const [companyForm, setCompanyForm] = useState({ legal_name: '', tax_code: '' });
  const [modelForm, setModelForm] = useState({ manufacturer: '', model_name: '', category: 'Collaboration', sku: '', ownership_type: 'sale', default_monthly_fee: '', notes: '' });
  const [profileForm, setProfileForm] = useState({ device_model_id: '', supplier: '', reference: '', purchased_on: '', unit_cost: '', quantity: '1', stock_location_id: '', notes: '' });
  const [purchaseProfileTab, setPurchaseProfileTab] = useState('details');
  const [purchaseOrderType, setPurchaseOrderType] = useState('hardware');
  const [licenseOrders, setLicenseOrders] = useState([]);
  const [licenseOrderSubTab, setLicenseOrderSubTab] = useState('orders');
  const [licenseFinanceRows, setLicenseFinanceRows] = useState([]);
  const [selectedLicenseFinanceOrderId, setSelectedLicenseFinanceOrderId] = useState('');
  const [globalCharges, setGlobalCharges] = useState([]);
  const [globalChargeForm, setGlobalChargeForm] = useState({ description: '', monthly_amount: '', license_order_id: '', starts_on: new Date().getFullYear() + '-10-01', duration_months: '60', apply_to_all: false, branch_ids: [] });
  const [licenseOrderForm, setLicenseOrderForm] = useState({ license_name: '', supplier: '', reference: '', purchased_on: '', quantity: '1', unit_cost: '', renewal_on: '', ea_starts_on: '2026-10-01', notes: '' });
  const [deviceForm, setDeviceForm] = useState({ model_id: '', purchase_profile_id: '', branch_id: '', stock_location_id: '', serial_number: '', status: 'in_stock', ownership_type: 'sale', purchase_cost: '', sale_price: '', monthly_fee: '', activated_on: new Date().toISOString().slice(0,10), notes: '' });
  const [userForm, setUserForm] = useState({ username: '', display_name: '', password: '', role: 'technician' });
  const [checklistForm, setChecklistForm] = useState({ title: 'Checklist installazione', items: 'Verifica collegamento rete\nVerifica alimentazione\nVerifica registrazione dispositivo' });
  const [locationForm, setLocationForm] = useState({ name: '', address: '' });
  const [movementForm, setMovementForm] = useState({ device_id: '', movement_type: 'trasferimento', from_location_id: '', to_location_id: '', branch_id: '', notes: '' });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cm-theme', theme);
  }, [theme]);

  useEffect(() => {
    api('/auth/me').then((result) => { setUser(result.user); setTheme(result.user.theme || 'light'); }).catch(() => setUser(null)).finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    const expired = () => { setUser(null); setError('Sessione scaduta. Accedi di nuovo.'); };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);

  const loadData = useCallback(async () => {
    if (!user) return;
    setError('');
    try {
      const results = await Promise.all([
        api('/branches'), api('/companies'), api('/devices' + (branchFilter === 'all' ? '' : '?branchId=' + branchFilter)),
        api('/device-models'), api('/purchase-profiles'), api('/stock/locations'), api('/stock/movements'), api('/product-stock'),
        api('/dashboard' + (branchFilter === 'all' ? '' : '?branchId=' + branchFilter)),
        api('/finance/dashboard' + (branchFilter === 'all' ? '' : '?branchId=' + branchFilter))
      ]);
      setBranches(results[0].data); setCompanies(results[1].data); setDevices(results[2].data);
      setModels(results[3].data); setPurchaseProfiles(results[4].data); setLocations(results[5].data); setMovements(results[6].data); setProductStock(results[7].data);
      setDashboard(results[8].data); setFinance(results[9].data);
      if (user.role === 'admin') {
        const [userResult, licenseResult, globalChargeResult, licenseFinanceResult] = await Promise.all([api('/admin/users'), api('/license-purchase-orders'), api('/global-monthly-charges'), api('/license-finance')]);
        setUsers(userResult.data);
        setLicenseOrders(licenseResult.data);
        setGlobalCharges(globalChargeResult.data);
        setLicenseFinanceRows(licenseFinanceResult.data);
      }
    } catch (err) { setError(err.message); }
  }, [user, branchFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (page === 'branchDetail' && selectedBranch) {
      if (branchTab === 'checklist') api('/branches/' + selectedBranch.id + '/checklists').then((result) => setChecklists(result.data)).catch((err) => setError(err.message));
      if (branchTab === 'companyHistory') api('/branches/' + selectedBranch.id + '/company-history').then((result) => setCompanyHistory(result.data)).catch((err) => setError(err.message));
    }
  }, [page, selectedBranch, branchTab]);

  const pageTitle = page === 'branchDetail' ? (selectedBranch?.nomenclature || selectedBranch?.street || 'Dettaglio filiale') : (navigation.find((item) => item.id === page)?.label || 'Dashboard');
  const matchesSearch = (record) => Object.values(record || {}).some((value) => value !== null && value !== undefined && String(value).toLocaleLowerCase('it').includes(search.trim().toLocaleLowerCase('it')));
  const filteredBranches = useMemo(() => branches.filter((branch) => matchesSearch(branch)), [branches, search]);
  const filteredDevices = useMemo(() => devices.filter((device) => matchesSearch(device)), [devices, search]);
  const filteredCompanies = useMemo(() => companies.filter((company) => matchesSearch(company)), [companies, search]);

  async function refresh() { await loadData(); }

  async function openBulkEditModal() {
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api('/devices');
      setBulkDevices(result.data || []);
      setBulkBranchIds([]);
      setBulkField('status');
      setBulkValue('to_activate');
      setModal('bulkDevices');
    } catch (err) {
      setError('Impossibile caricare i device per la modifica massiva: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitBulkDeviceUpdate(event) {
    event.preventDefault();
    const fieldLabels = {
      activated_on: 'data di attivazione',
      status: 'stato',
      purchase_profile_id: 'ordine di provenienza',
      stock_location_id: 'magazzino di provenienza'
    };
    const fieldNames = { in_stock: 'A magazzino', to_activate: 'Da attivare', operational: 'Operativo', fault: 'Guasto', decommissioned: 'Dismesso' };
    const valueLabel = bulkField === 'activated_on' ? (bulkValue || 'vuota')
      : bulkField === 'status' ? (fieldNames[bulkValue] || bulkValue)
      : bulkField === 'purchase_profile_id' ? (purchaseProfiles.find((item) => String(item.id) === String(bulkValue))?.reference || purchaseProfiles.find((item) => String(item.id) === String(bulkValue))?.supplier || (bulkValue ? 'Ordine #' + bulkValue : 'nessun ordine'))
      : (locations.find((item) => String(item.id) === String(bulkValue))?.name || (bulkValue ? 'Magazzino #' + bulkValue : 'nessun magazzino'));
    const branchLabel = bulkBranchIds.length ? 'nelle filiali selezionate' : 'in tutte le filiali';
    const changedCount = bulkDevices.filter((device) => {
      if (device.branch_id == null || (bulkBranchIds.length && !bulkBranchIds.includes(String(device.branch_id)))) return false;
      const current = bulkField === 'activated_on' ? String(device.activated_on || device.installed_on || '').slice(0, 10) : device[bulkField];
      return String(current ?? '') !== String(bulkValue ?? '');
    }).length;
    if (!changedCount) {
      setError('Nessun device da aggiornare: il valore scelto è già impostato oppure non ci sono device nelle filiali selezionate.');
      return;
    }
    if (!window.confirm('Modificare ' + fieldLabels[bulkField] + ' in ' + valueLabel + ' per ' + changedCount + ' device ' + branchLabel + '? Gli altri campi resteranno invariati.')) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api('/devices/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ field: bulkField, value: bulkValue, branch_ids: bulkBranchIds.map(Number) })
      });
      setModal('');
      await refresh();
      setSuccess((result.updated_count || 0) + ' device aggiornati: ' + fieldLabels[bulkField] + '.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function prepareDeviceImport(file) {
    setBusy(true); setError(''); setSuccess('');
    file.text().then((text) => {
      const parsed = parseDeviceCsv(text);
      const prepared = parsed.map((row) => {
        const model = models.find((item) =>
          (row.sku && normalizeText(item.sku) === normalizeText(row.sku)) ||
          (row.modelName && normalizeText(item.model_name) === normalizeText(row.modelName))
        );
        const company = companies.find((item) => normalizeText(item.legal_name) === normalizeText(row.companyName));
        const branchMatches = branches.filter((branch) =>
          (!row.companyName || Number(branch.company_id) === Number(company?.id)) &&
          [branch.nomenclature, branch.street, branch.previous_nomenclature].some((name) =>
            normalizeText(name) === normalizeText(row.branchName)
          )
        );
        const branch = branchMatches.length === 1 ? branchMatches[0] : null;
        const stockLocation = locations.find((item) => normalizeText(item.name) === normalizeText(row.stockLocationName));
        return {
          ...row,
          model_id: model ? String(model.id) : '',
          branch_id: branch ? String(branch.id) : '',
          stock_location_id: stockLocation ? String(stockLocation.id) : '',
          ownership_type: row.contract === 'NOL' || normalizeText(row.contract) === 'noleggio' ? 'rental' : 'sale',
          status: normalizeText(row.statusText) === 'operativo' || normalizeText(row.statusText) === 'operational' ? 'operational'
            : normalizeText(row.statusText) === 'guasto' || normalizeText(row.statusText) === 'fault' ? 'fault'
            : normalizeText(row.statusText) === 'dismesso' || normalizeText(row.statusText) === 'decommissioned' ? 'decommissioned'
            : normalizeText(row.statusText) === 'da attivare' || normalizeText(row.statusText) === 'to activate' ? 'to_activate' : 'to_activate',
          purchase_cost: row.purchaseCost.replace(',', '.'),
          monthly_fee: row.monthlyFee.replace(',', '.'),
          sale_price: '',
          branch_missing: !branch,
          model_missing: !model,
          stock_location_missing: Boolean(row.stockLocationName && !stockLocation)
        };
      });
      setDeviceImportRows(prepared);
      setModal('importDevices');
      if (!prepared.length) setError('Il CSV non contiene righe dispositivo valide.');
    }).catch((err) => setError('Lettura CSV non riuscita: ' + err.message)).finally(() => setBusy(false));
  }

  async function executeDeviceImport() {
    const invalid = deviceImportRows.filter((row) => !row.model_id || !row.branch_id);
    if (invalid.length) {
      setError('Completa la selezione di modello e filiale per tutte le righe prima di importare. Nessuna anagrafica verrà creata automaticamente.');
      return;
    }
    setBusy(true); setError(''); setSuccess('');
    let imported = 0, failed = 0;
    const failures = [];
    for (const row of deviceImportRows) {
      try {
        const body = {
          model_id: Number(row.model_id),
          branch_id: Number(row.branch_id),
          stock_location_id: row.stock_location_id ? Number(row.stock_location_id) : null,
          serial_number: row.serial || null,
          status: row.status || 'to_activate',
          ownership_type: row.ownership_type,
          purchase_cost: row.purchase_cost === '' ? null : Number(row.purchase_cost),
          monthly_fee: row.monthly_fee === '' ? null : Number(row.monthly_fee),
          installed_on: row.activationDate || null,
          notes: [row.notes, row.stockLocationName && !row.stock_location_id ? 'Magazzino indicato nel CSV non abbinato: ' + row.stockLocationName : ''].filter(Boolean).join(' | ')
        };
        await api('/devices', { method: 'POST', body: JSON.stringify(body) });
        imported += 1;
      } catch (err) {
        failed += 1;
        failures.push('Riga ' + row.rowNumber + ': ' + err.message);
      }
    }
    await refresh();
    setModal('');
    setSuccess('Import dispositivi concluso: ' + imported + ' importati, ' + failed + ' non importati.' + (failed ? ' Controlla gli errori riportati.' : ''));
    if (failures.length) setError(failures.slice(0, 8).join(' · '));
    setBusy(false);
  }

  async function importNetworkCsv(file) {
    setBusy(true); setError(''); setSuccess('');
    try {
      const text = await file.text();
      const rows = parseNetworkCsv(text);
      if (!rows.length) throw new Error('Nessuna filiale valida trovata nel CSV.');
      const companyCache = [...companies];
      const currentBranches = [...branches];
      const findCompany = (name) => companyCache.find((company) => normalizeText(company.legal_name) === normalizeText(name));
      let added = 0, updated = 0, skipped = 0;
      const seen = new Set();
      for (const row of rows) {
        const split = row.companyName
          ? { companyName: row.companyName, branchName: row.branchName }
          : splitNetworkBranch(row.combined, companyCache.map((company) => company.legal_name));
        if (!split.branchName) { skipped += 1; continue; }
        const key = normalizeText(split.companyName) + '|' + normalizeText(split.branchName);
        if (seen.has(key)) { skipped += 1; continue; }
        seen.add(key);
        let company = findCompany(split.companyName);
        if (!company) {
          const result = await api('/companies', { method: 'POST', body: JSON.stringify({ legal_name: split.companyName, tax_code: '' }) });
          company = result.data;
          companyCache.push(company);
        }
        const existing = currentBranches.find((branch) =>
          Number(branch.company_id) === Number(company.id) &&
          [branch.nomenclature, branch.street, branch.previous_nomenclature].some((value) => normalizeText(value) === normalizeText(split.branchName) || (row.oldName && normalizeText(value) === normalizeText(row.oldName)))
        );
        const body = {
          company_id: Number(company.id),
          country: 'Italia',
          street: split.branchName,
          nomenclature: row.newName && row.newName !== '/' ? row.newName : (existing?.nomenclature || split.branchName),
          previous_nomenclature: row.oldName || existing?.previous_nomenclature || '',
          network: row.lan,
          phone_prefix: row.prefix,
          is_active: true,
          active_since: '2026-10-01',
          wlc: row.wlc
        };
        if (existing) {
          await api('/branches/' + existing.id, { method: 'PUT', body: JSON.stringify(body) });
          Object.assign(existing, body);
          updated += 1;
        } else {
          const result = await api('/branches', { method: 'POST', body: JSON.stringify(body) });
          currentBranches.push(result.data);
          added += 1;
        }
      }
      await refresh();
      setSuccess('Import NETWORK completato: ' + added + ' nuove filiali, ' + updated + ' aggiornate, ' + skipped + ' ignorate. Nessuna filiale è stata eliminata.');
    } catch (err) {
      setError('Import NETWORK interrotto: ' + err.message + ' Se sono già state elaborate alcune righe, verifica l’elenco prima di ripetere l’importazione.');
    } finally { setBusy(false); }
  }

  async function deleteDevice(device) {
    const label = [device.sku, device.manufacturer, device.model_name, device.serial_number].filter(Boolean).join(' · ');
    if (!window.confirm('ATTENZIONE: eliminare definitivamente il device ' + (label || ('#' + device.id)) + '? L’operazione non è reversibile. Se il dispositivo è collegato a registrazioni che ne impediscono l’eliminazione, il sistema mostrerà un errore senza cancellare i dati collegati.')) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api('/devices/' + device.id, { method: 'DELETE' });
      setModal('');
      await refresh();
      setSuccess('Device eliminato.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* Session may already be expired. */ }
    setUser(null); setProfileOpen(false); setPage('dashboard');
  }

  async function submitForm(action, body, close = true) {
    setBusy(true); setError(''); setSuccess('');
    try {
      await action(body);
      if (close) setModal('');
      setSuccess('Modifiche salvate correttamente.');
      await refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function openBranch(branch) {
    setSelectedBranch(branch);
    setBranchTab('details');
    setPage('branchDetail');
    setSearch('');
  }

  async function deleteCompanyHistoryEntry(item) {
    const message = `Vuoi eliminare lo storico del cambio ${item.from_company_name} → ${item.to_company_name}?`;
    if (!window.confirm(message)) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api('/branches/' + selectedBranch.id + '/company-history/' + item.id, { method: 'DELETE' });
      setCompanyHistory((current) => current.filter((entry) => String(entry.id) !== String(item.id)));
      setSuccess('Voce dello storico eliminata.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function deletePurchaseProfile(profile) {
    const label = [profile.manufacturer, profile.model_name, profile.reference].filter(Boolean).join(' · ');
    if (!window.confirm('Vuoi eliminare l’ordine "' + label + '"? Il carico di magazzino verrà stornato. Gli ordini con device collegati non possono essere eliminati.')) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api('/purchase-profiles/' + profile.id, { method: 'DELETE' });
      setSuccess('Ordine eliminato e giacenza aggiornata.');
      await refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function deleteLicenseOrder(order) {
    if (!window.confirm('Vuoi eliminare l’ordine licenze "' + order.license_name + '"?')) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api('/license-purchase-orders/' + order.id, { method: 'DELETE' });
      setSuccess('Ordine licenze eliminato.');
      await refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }



  async function deleteGlobalCharge(charge) {
    if (!window.confirm('Vuoi eliminare il canone globale "' + charge.description + '"?')) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api('/global-monthly-charges/' + charge.id, { method: 'DELETE' });
      setSuccess('Canone globale eliminato.');
      await refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  if (authLoading) return <div className="boot-screen"><div className="login-mark">CM</div><span>Caricamento workspace…</span></div>;
  if (!user) return <Login onLogin={(loggedUser) => { setUser(loggedUser); setTheme(loggedUser.theme || 'light'); setError(''); }} />;

  return (
    <div className="app-shell">
      <aside className={'sidebar ' + (mobileNavOpen ? 'sidebar-open' : '')}>
        <div className="sidebar-brand"><div className="brand-mark">CM</div><div><strong>Client Management</strong><span>ASSET WORKSPACE</span></div><button className="mobile-close icon-button" onClick={() => setMobileNavOpen(false)} aria-label="Chiudi menu">×</button></div>
        <div className="nav-section-label">WORKSPACE</div>
        <nav className="main-nav">{navigation.map((item) => <button key={item.id} className={'nav-item ' + (page === item.id || (page === 'branchDetail' && item.id === 'branches') ? 'active' : '')} onClick={() => { setPage(item.id); setSearch(''); setMobileNavOpen(false); }}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id === 'devices' && devices.some((device) => device.status === 'fault') && <span className="nav-dot" />}</button>)}</nav>
        <div className="sidebar-bottom"><div className="connection-indicator"><span />API connessa</div><div className="sidebar-version">Client Management <span>v0.2 · Workspace</span></div></div>
      </aside>
      {mobileNavOpen && <button className="nav-scrim" aria-label="Chiudi menu" onClick={() => setMobileNavOpen(false)} />}
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left"><button className="mobile-menu icon-button" onClick={() => setMobileNavOpen(true)} aria-label="Apri menu">☰</button><div><div className="breadcrumb">WORKSPACE <span>/</span> {pageTitle.toUpperCase()}</div><h1>{pageTitle}</h1></div></div>
          <div className="topbar-actions">
            <label className="branch-filter"><span>Filiale</span><select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)}><option value="all">Tutte le filiali</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.nomenclature || branch.street}</option>)}</select></label>
            <div className="profile-wrap"><button className="profile-button" onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen}><span className="avatar">{initials(user.display_name)}</span><span className="profile-copy"><strong>{user.display_name}</strong><small>{user.role}</small></span><span className="chevron">⌄</span></button>{profileOpen && <div className="profile-menu"><div className="profile-menu-heading"><strong>{user.display_name}</strong><span>{user.username}</span></div><div className="theme-row"><span><span className="theme-symbol">{theme === 'dark' ? '☾' : '☼'}</span>Tema {theme === 'dark' ? 'scuro' : 'chiaro'}</span><button className={'toggle ' + (theme === 'dark' ? 'toggle-on' : '')} onClick={async () => { const nextTheme = theme === 'dark' ? 'light' : 'dark'; setTheme(nextTheme); try { const result = await api('/auth/preferences', { method: 'PUT', body: JSON.stringify({ theme: nextTheme }) }); setUser(result.user); } catch (err) { setError(err.message); } }} aria-label="Cambia tema"><span /></button></div><button className="menu-action" onClick={logout}>↪ <span>Esci dal portale</span></button></div>}</div>
          </div>
        </header>
        <div className="content-area">
          <ErrorNotice message={error} onClose={() => setError('')} />
          {success && <div className="notice notice-success"><span>{success}</span><button className="icon-button" onClick={() => setSuccess('')} aria-label="Chiudi">×</button></div>}

          {page === 'dashboard' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">PANORAMICA</p><h2>Buongiorno, {user.display_name.split(' ')[0]}.</h2><p className="muted">Ecco la situazione attuale del tuo workspace.</p></div><button className="secondary-button" onClick={refresh}>↻ Aggiorna</button></div><div className="stats-grid"><StatCard label="Filiali" value={dashboard?.branches ?? '—'} caption="Sedi registrate" icon="⌂" /><StatCard label="Device" value={dashboard?.devices ?? '—'} caption="Apparati censiti" icon="▣" tone="violet" /><StatCard label="Da verificare" value={dashboard?.faults ?? '—'} caption="Device in stato guasto" icon="!" tone="amber" /><StatCard label="Canoni mensili" value={money(dashboard?.monthlyFees)} caption="Device NOL + canoni globali attivi" icon="€" tone="green" /></div><div className="dashboard-grid"><section className="panel"><div className="panel-heading"><div><h3>Attività operative</h3><p>Riepilogo del parco device</p></div><button className="text-button" onClick={() => setPage('devices')}>Vedi device →</button></div><div className="activity-list"><div className="activity-row"><span className="activity-icon blue">▣</span><div><strong>Dispositivi a magazzino</strong><small>Disponibili per assegnazione</small></div><b>{dashboard?.stock ?? '—'}</b></div><div className="activity-row"><span className="activity-icon amber">!</span><div><strong>Dispositivi guasti</strong><small>Richiedono una verifica</small></div><b>{dashboard?.faults ?? '—'}</b></div><div className="activity-row"><span className="activity-icon green">€</span><div><strong>Canoni mensili</strong><small>Somma dei canoni dei device</small></div><b>{money(dashboard?.monthlyFees)}</b></div></div></section><section className="panel quick-panel"><div className="panel-heading"><div><h3>Accesso rapido</h3><p>Le azioni più utilizzate</p></div></div><button className="quick-action" onClick={() => setModal('branch')}><span className="quick-icon">＋</span><span><strong>Nuova filiale</strong><small>Aggiungi una sede al workspace</small></span><span className="quick-arrow">→</span></button><button className="quick-action" onClick={() => setModal('device')}><span className="quick-icon purple">▣</span><span><strong>Registra device</strong><small>Inserisci un nuovo apparato</small></span><span className="quick-arrow">→</span></button><button className="quick-action" onClick={() => { setPage('admin'); setAdminTab('models'); }}><span className="quick-icon green">⌘</span><span><strong>Catalogo modelli</strong><small>Gestisci i valori precompilati</small></span><span className="quick-arrow">→</span></button></section></div></section>}

          {page === 'branches' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">ANAGRAFICA</p><h2>Le tue filiali</h2><p className="muted">Anagrafica delle filiali: ragione sociale, nuova nomenclatura, paese, indirizzo, prefisso, LAN e WLC.</p></div><div className="page-actions"><button className="secondary-button" onClick={() => downloadCsv("filiali-" + new Date().toISOString().slice(0,10) + ".csv", [{label:"Ragione sociale",value:(row)=>row.company_name},{label:"Paese",value:(row)=>row.country},{label:"Indirizzo",value:(row)=>row.street},{label:"Nomenclatura",value:(row)=>row.nomenclature},{label:"Vecchia nomenclatura",value:(row)=>row.previous_nomenclature},{label:"Prefisso",value:(row)=>row.phone_prefix},{label:"LAN",value:(row)=>row.network},{label:"WLC",value:(row)=>row.wlc},{label:"Attiva",value:(row)=>row.is_active ? "Sì" : "No"},{label:"Attiva dal",value:(row)=>row.active_since}], filteredBranches)}>Esporta CSV</button><label className="secondary-button file-import-button">Importa CSV NETWORK<input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) importNetworkCsv(file); event.target.value = ''; }} /></label><button className="primary-button" onClick={() => { setBranchForm(emptyBranch); setModal('branch'); }}>＋ Nuova filiale</button></div></div><div className="toolbar"><label className="search-box"><span>⌕</span><input placeholder="Cerca ragione sociale, paese, indirizzo, network…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="result-count">{filteredBranches.length} filiali</span></div><div className="table-panel"><table><thead><tr><th>Ragione sociale</th><th>Paese</th><th>Indirizzo</th><th>Prefisso</th><th>LAN</th><th>WLC</th><th /></tr></thead><tbody>{filteredBranches.map((branch) => <tr key={branch.id} onClick={() => openBranch(branch)} className="clickable-row"><td><strong>{branch.company_name}</strong><small>{branch.nomenclature || 'Nomenclatura non impostata'}</small></td><td>{branch.country || '—'}</td><td className="branch-address-cell">{branch.street || '—'}</td><td>{branch.phone_prefix || '—'}</td><td><span className="soft-tag">{branch.network || '—'}</span></td><td>{branch.wlc || '—'}</td><td><button className="row-action" onClick={(event) => { event.stopPropagation(); openBranch(branch); }}>Apri →</button></td></tr>)}</tbody></table>{!filteredBranches.length && <EmptyState icon="⌂" title="Nessuna filiale presente" description="Crea una filiale per iniziare a organizzare il workspace." />}</div></section>}

          {page === 'branchDetail' && selectedBranch && <section className="page-content"><button className="back-link" onClick={() => setPage('branches')}>← Torna alle filiali</button><div className="detail-heading"><div className="branch-emblem">⌂</div><div><p className="eyebrow">SCHEDA FILIALE</p><h2>{selectedBranch.nomenclature || selectedBranch.street}</h2><p className="muted">{selectedBranch.company_name} · {selectedBranch.country} · {selectedBranch.street}</p></div><button className="secondary-button" onClick={() => { setBranchForm({ company_id: String(selectedBranch.company_id), country: selectedBranch.country || '', street: selectedBranch.street || '', nomenclature: selectedBranch.nomenclature || '', previous_nomenclature: selectedBranch.previous_nomenclature || '', network: selectedBranch.network || '', phone_prefix: selectedBranch.phone_prefix || '', wlc: selectedBranch.wlc || '', is_active: selectedBranch.is_active !== false, active_since: String(selectedBranch.active_since || '2026-10-01').slice(0,10) }); setModal('editBranch'); }}>Modifica anagrafica</button></div><div className="tabs"><button className={branchTab === 'details' ? 'selected' : ''} onClick={() => setBranchTab('details')}>Anagrafica</button><button className={branchTab === 'devices' ? 'selected' : ''} onClick={() => setBranchTab('devices')}>Devices <span>{devices.filter((device) => String(device.branch_id) === String(selectedBranch.id)).length}</span></button><button className={branchTab === 'checklist' ? 'selected' : ''} onClick={() => setBranchTab('checklist')}>Check-list</button><button className={branchTab === 'companyHistory' ? 'selected' : ''} onClick={() => setBranchTab('companyHistory')}>Storico ragione sociale</button></div>{branchTab === 'details' && <div className="detail-grid">{[['Ragione sociale', selectedBranch.company_name], ['Paese', selectedBranch.country], ['Indirizzo', selectedBranch.street], ['Nomenclatura', selectedBranch.nomenclature], ['Vecchia nomenclatura', selectedBranch.previous_nomenclature], ['Network', selectedBranch.network], ['Phone Prefix', selectedBranch.phone_prefix], ['WLC', selectedBranch.wlc], ['Stato filiale', selectedBranch.is_active ? 'Attiva' : 'Non attiva'], ['Attiva dal', date(selectedBranch.active_since)]].map(([label, value]) => <article className="detail-field" key={label}><span>{label}</span><strong>{value || '—'}</strong></article>)}</div>}{branchTab === 'devices' && <div className="panel"><div className="panel-heading"><div><h3>Device installati</h3><p>Apparati associati a questa filiale</p></div><button className="primary-button" onClick={() => { setDeviceForm((form) => ({ ...form, branch_id: String(selectedBranch.id), status: 'operational' })); setModal('device'); }}>＋ Aggiungi device</button></div><DeviceTable devices={devices.filter((device) => String(device.branch_id) === String(selectedBranch.id))} />{!devices.some((device) => String(device.branch_id) === String(selectedBranch.id)) && <EmptyState icon="▣" title="Nessun device installato" description="Aggiungi il primo dispositivo a questa filiale." />}</div>}{branchTab === 'companyHistory' && <div className="panel"><div className="panel-heading"><div><h3>Storico ragione sociale</h3><p>Traccia i cambi di società associata a questa filiale.</p></div></div>{companyHistory.length ? <div className="history-list">{companyHistory.map((item) => <article className="history-entry" key={item.id}><div className="history-marker" /><div className="history-entry-content"><strong>{item.from_company_name} <span>→</span> {item.to_company_name}</strong><p>{new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.changed_at))} · Modifica di {item.changed_by || 'Utente non disponibile'}</p></div><button className="history-delete-button" type="button" title="Elimina voce dello storico" aria-label={`Elimina cambio ${item.from_company_name} → ${item.to_company_name}`} disabled={busy} onClick={() => deleteCompanyHistoryEntry(item)}>×</button></article>)}</div> : <EmptyState icon="↔" title="Nessun cambio registrato" description="Quando la ragione sociale associata alla filiale passerà, ad esempio, da AFIS a IDRAS, il cambiamento comparirà qui." />}</div>}{branchTab === 'checklist' && <div className="panel"><div className="panel-heading"><div><h3>Check-list operative</h3><p>Controlli e attività della filiale</p></div><button className="primary-button" onClick={() => setModal('checklist')}>＋ Nuova checklist</button></div>{checklists.map((checklist) => <div className="checklist-card" key={checklist.id}><div className="checklist-card-heading"><strong>{checklist.title}</strong><span className={'soft-tag ' + (checklist.status === 'completed' ? 'green-tag' : '')}>{checklist.status === 'completed' ? 'Completata' : 'Aperta'}</span></div>{checklist.items.map((item) => <label className="checklist-item" key={item.id}><input type="checkbox" checked={item.is_checked} onChange={async (event) => { try { await api('/checklist-items/' + item.id, { method: 'PATCH', body: JSON.stringify({ is_checked: event.target.checked }) }); const result = await api('/branches/' + selectedBranch.id + '/checklists'); setChecklists(result.data); } catch (err) { setError(err.message); } }} /><span>{item.label}</span></label>)}</div>)}{!checklists.length && <EmptyState icon="☷" title="Nessuna checklist" description="Crea una checklist per registrare le verifiche operative." />}</div>}</section>}

          {page === 'devices' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">INVENTARIO</p><h2>Parco device</h2><p className="muted">Inventario centralizzato degli apparati e delle loro assegnazioni.</p></div><div className="page-actions"><button className="secondary-button" onClick={() => downloadCsv("device-" + new Date().toISOString().slice(0,10) + ".csv", [{label:"SKU",value:(row)=>row.sku},{label:"Marca",value:(row)=>row.manufacturer},{label:"Modello",value:(row)=>row.model_name},{label:"Matricola",value:(row)=>row.serial_number},{label:"Ragione sociale",value:(row)=>row.company_name},{label:"Filiale",value:(row)=>row.branch_nomenclature},{label:"Stato",value:(row)=>row.status},{label:"Contratto",value:(row)=>row.ownership_type === "rental" ? "NOL" : "DDE"},{label:"Costo acquisto",value:(row)=>row.purchase_cost},{label:"Canone mensile",value:(row)=>row.monthly_fee},{label:"Data attivazione",value:(row)=>row.activated_on || row.installed_on},{label:"Magazzino di provenienza",value:(row)=>row.stock_location}], filteredDevices)}>Esporta CSV</button><label className="secondary-button file-import-button">Importa CSV device<input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) prepareDeviceImport(file); event.target.value = ""; }} /></label><button className="primary-button" onClick={() => { setDeviceForm({ model_id: "", purchase_profile_id: "", branch_id: "", stock_location_id: "", serial_number: "", status: "in_stock", ownership_type: "sale", purchase_cost: "", sale_price: "", monthly_fee: "", activated_on: new Date().toISOString().slice(0,10), notes: "" }); setModal("device"); }}>＋ Registra device</button></div></div><div className="toolbar"><label className="search-box"><span>⌕</span><input placeholder="Cerca modello, matricola, filiale…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="result-count">{filteredDevices.length} dispositivi</span></div><div className="panel bulk-status-panel"><div><h3>Modifica massiva</h3><p className="muted">Aggiorna un singolo campo delle schede device per tutte le filiali o solo per quelle selezionate.</p></div><div className="bulk-status-actions"><button className="primary-button" disabled={busy} onClick={openBulkEditModal}>✎ Modifica campi device</button></div></div><div className="table-panel"><DeviceTable devices={filteredDevices} onEdit={(device) => { setDeviceForm({ model_id: String(device.model_id), purchase_profile_id: device.purchase_profile_id ? String(device.purchase_profile_id) : '', branch_id: device.branch_id ? String(device.branch_id) : '', stock_location_id: device.stock_location_id ? String(device.stock_location_id) : '', was_assigned: Boolean(device.branch_id), serial_number: device.serial_number || '', status: device.status, ownership_type: device.ownership_type, purchase_cost: device.purchase_cost ?? '', sale_price: device.sale_price ?? '', monthly_fee: device.monthly_fee ?? '', activated_on: String(device.activated_on || device.installed_on || new Date().toISOString().slice(0,10)).slice(0,10), notes: device.notes || '' }); setModal('editDevice:' + device.id); }} />{!filteredDevices.length && <EmptyState icon="▣" title="Nessun dispositivo trovato" description="Registra un dispositivo oppure modifica i filtri di ricerca." />}</div></section>}

          {page === 'finance' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">PANORAMICA ECONOMICA</p><h2>Finance dashboard</h2><p className="muted">Riepilogo economico del parco dispositivi. Le altre funzioni Finance saranno aggiunte in una fase successiva.</p></div><span className="soft-tag">Dashboard</span></div><div className="stats-grid finance-stats"><StatCard label="NOL · mese corrente" value={money(finance?.nol_current_month)} caption="Canoni maturati nel mese" icon="↻" tone="green" /><StatCard label="NOL · totale storico" value={money(finance?.nol_all_time)} caption="Mesi completi maturati" icon="€" tone="violet" /><StatCard label="Vendite DDE · mese" value={money(finance?.sales_current_month)} caption="Vendite del mese corrente" icon="↗" /><StatCard label="Vendite DDE · totale" value={money(finance?.sales_all_time)} caption="Vendite registrate" icon="€" tone="amber" /><StatCard label="Costi sostenuti" value={money(finance?.total_costs)} caption="Hardware, licenze e altri costi" icon="↘" tone="amber" /><StatCard label="Margine complessivo" value={money(finance?.overall_margin)} caption="Ricavi NOL, DDE e canoni meno costi" icon="€" tone={Number(finance?.overall_margin || 0) >= 0 ? "green" : "amber"} /></div><div className="panel finance-note"><div className="finance-note-icon">€</div><div><h3>Recupero costi NOL</h3><p>Saldo complessivo canoni maturati meno costo effettivo dei device: <strong>{money(finance?.nol_balance)}</strong>. Esempio: costo €100 e canone €10/mese, dopo 2 mesi completi il saldo è -€80.</p></div></div></section>}

          {page === 'warehouse' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">LOGISTICA</p><h2>Magazzino</h2><p className="muted">Ubicazioni e storico dei movimenti delle apparecchiature.</p></div><button className="primary-button" onClick={() => setModal('location')}>＋ Nuova ubicazione</button></div><div className="stats-grid two-stats"><StatCard label="Ubicazioni" value={locations.length} caption="Magazzini configurati" icon="▤" /><StatCard label="Device in stock" value={devices.filter((device) => device.status === 'in_stock').length} caption="Disponibili a magazzino" icon="▣" tone="green" /></div><div className="panel"><div className="panel-heading"><div><h3>Ubicazioni</h3><p>Magazzini disponibili</p></div></div>{locations.length ? <div className="location-grid">{locations.map((location) => <article className="location-card" key={location.id}><span className="location-icon">▤</span><div><strong>{location.name}</strong><p>{location.address || 'Indirizzo non impostato'}</p></div><span className="location-count">{location.device_count} device</span>{(user.role === 'admin' || user.role === 'warehouse') && <button className="secondary-button" onClick={() => { setLocationForm({ name: location.name, address: location.address || '' }); setModal('editLocation:' + location.id); }}>Modifica</button>}</article>)}</div> : <EmptyState icon="▤" title="Nessun magazzino configurato" description="Aggiungi un'ubicazione, ad esempio Molo STC o Magazzino Clerici." />}</div><div className="panel"><div className="panel-heading"><div><h3>Quantità per prodotto</h3><p>Disponibilità per SKU e ubicazione, aggiornata dagli ordini registrati.</p></div></div>{productStock.length?<div className="table-panel nested-table"><table><thead><tr><th>SKU</th><th>Prodotto</th><th>Magazzino</th><th>Quantità</th></tr></thead><tbody>{productStock.map((item)=><tr key={item.id}><td>{item.sku||'—'}</td><td>{item.manufacturer} {item.model_name}</td><td>{item.stock_location_name}</td><td><strong>{item.quantity}</strong></td></tr>)}</tbody></table></div>:<EmptyState icon="▤" title="Nessuna giacenza per prodotto" description="Registra un ordine con quantità e magazzino nella sezione Storico acquisti." />}</div><div className="panel"><div className="panel-heading"><div><h3>Ultimi movimenti</h3><p>Gli ultimi 100 movimenti registrati</p></div><button className="secondary-button" onClick={() => setModal('movement')}>Registra movimento</button></div>{movements.length ? <div className="movement-list">{movements.map((movement) => <div className="movement-row" key={movement.id}><span className="activity-icon blue">↔</span><div><strong>{movement.manufacturer} {movement.model_name} {movement.asset_tag ? '· ' + movement.asset_tag : ''}</strong><small>{movement.from_location_name || '—'} → {movement.to_location_name || movement.branch_nomenclature || '—'}</small></div><time>{date(movement.moved_at)}</time></div>)}</div> : <EmptyState icon="↔" title="Nessun movimento registrato" description="I movimenti appariranno qui dopo la prima registrazione." />}</div></section>}

          {page === 'admin' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">CONFIGURAZIONE</p><h2>Amministrazione</h2><p className="muted">Gestisci le anagrafiche di riferimento e i valori precompilati.</p></div></div><div className="tabs admin-tabs"><button className={adminTab === 'companies' ? 'selected' : ''} onClick={() => setAdminTab('companies')}>Ragioni sociali</button><button className={adminTab === 'models' ? 'selected' : ''} onClick={() => setAdminTab('models')}>Catalogo device</button>{user.role === 'admin' && <button className={adminTab === 'profiles' ? 'selected' : ''} onClick={() => setAdminTab('profiles')}>Storico acquisti</button>}{user.role === 'admin' && <button className={adminTab === 'users' ? 'selected' : ''} onClick={() => setAdminTab('users')}>Utenti</button>}</div>{adminTab === 'companies' && <div className="panel"><div className="panel-heading"><div><h3>Ragioni sociali</h3><p>Società utilizzabili nelle anagrafiche filiale</p></div><button className="primary-button" onClick={() => { setCompanyForm({ legal_name: '', tax_code: '' }); setModal('company'); }}>＋ Nuova ragione sociale</button></div>{companies.length ? <><label className="search-box"><span>⌕</span><input placeholder="Cerca in tutti i campi della ragione sociale…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="table-panel nested-table"><table><thead><tr><th>Ragione sociale</th><th>Codice fiscale / P.IVA</th><th>Filiali</th></tr></thead><tbody>{filteredCompanies.map((company) => <tr key={company.id}><td><strong>{company.legal_name}</strong></td><td>{company.tax_code || '—'}</td><td>{company.branch_count ?? 0}</td></tr>)}</tbody></table></div></> : <EmptyState icon="⌂" title="Nessuna ragione sociale" description="Aggiungi le società prima di creare le filiali." />}{companies.length > 0 && filteredCompanies.length === 0 && <EmptyState icon="⌕" title="Nessun risultato" description="Nessuna ragione sociale contiene il testo cercato." />}</div>}{adminTab === 'models' && <div className="panel"><div className="panel-heading"><div><h3>Catalogo device</h3><p>SKU e canone NOL standard; il costo effettivo viene registrato per lotto.</p></div><button className="primary-button" onClick={() => { setModelForm({ manufacturer: '', model_name: '', category: 'Collaboration', sku: '', ownership_type: 'sale', default_monthly_fee: '', notes: '' }); setModal('model'); }}>＋ Nuovo prodotto</button></div>{models.length ? <div className="table-panel nested-table"><table><thead><tr><th>SKU</th><th>Prodotto</th><th>Categoria</th><th>Canone NOL</th><th></th></tr></thead><tbody>{models.map((model) => <tr key={model.id}><td>{model.sku || '—'}</td><td><strong>{model.manufacturer}</strong><small>{model.model_name}</small></td><td>{model.category}</td><td>{money(model.default_monthly_fee)}</td><td><button className="secondary-button" onClick={() => { setModelForm({ manufacturer:model.manufacturer, model_name:model.model_name, category:model.category, sku:model.sku||'', ownership_type:model.ownership_type, default_monthly_fee:model.default_monthly_fee??'', notes:model.notes||'' }); setModal('editModel:'+model.id); }}>Modifica</button></td></tr>)}</tbody></table></div> : <EmptyState icon="▣" title="Catalogo vuoto" description="Aggiungi modelli come Cisco Room Bar per precompilare i dati dei device." />}</div>}{adminTab === 'profiles' && user.role === 'admin' && <section className="profile-orders-section"><div className="tabs"><button className={purchaseOrderType === 'hardware' ? 'selected' : ''} onClick={() => setPurchaseOrderType('hardware')}>Ordini hardware</button><button className={purchaseOrderType === 'licenses' ? 'selected' : ''} onClick={() => setPurchaseOrderType('licenses')}>Ordini licenze</button><button className={purchaseOrderType === 'global' ? 'selected' : ''} onClick={() => setPurchaseOrderType('global')}>Canoni globali</button></div>
{purchaseOrderType === 'hardware' && <div className="panel"><div className="panel-heading"><div><h3>Ordini hardware</h3><p>Acquisti di dispositivi e carichi di magazzino.</p></div><button className="primary-button" onClick={() => { setProfileForm({ device_model_id: '', supplier: '', reference: '', purchased_on: '', unit_cost: '', quantity: '1', stock_location_id: '', notes: '' }); setPurchaseProfileTab('details'); setModal('purchaseProfile'); }}>＋ Nuovo riferimento</button></div>{purchaseProfiles.length ? <div className="table-panel nested-table"><table><thead><tr><th>Modello</th><th>Data ordine</th><th>Fornitore / numero documento</th><th>Costo unitario</th><th>Quantità</th><th></th></tr></thead><tbody>{purchaseProfiles.map((profile) => <tr key={profile.id}><td><strong>{profile.manufacturer} {profile.model_name}</strong></td><td>{date(profile.purchased_on)}</td><td>{profile.supplier || '—'}<small>{profile.reference || ''}</small></td><td>{money(profile.unit_cost)}</td><td>{profile.quantity ?? 1}</td><td><div className="table-actions"><button className="secondary-button" onClick={() => { setProfileForm({ device_model_id:String(profile.device_model_id), supplier:profile.supplier||'', reference:profile.reference||'', purchased_on:profile.purchased_on ? String(profile.purchased_on).slice(0,10) : '', unit_cost:profile.unit_cost??'', quantity:String(profile.quantity??1), stock_location_id:profile.stock_location_id?String(profile.stock_location_id):'', notes:profile.notes||'' }); setPurchaseProfileTab('details'); setModal('editPurchaseProfile:'+profile.id); }}>Modifica</button><button className="secondary-button" disabled={busy} onClick={() => deletePurchaseProfile(profile)}>Elimina</button></div></td></tr>)}</tbody></table></div> : <EmptyState icon="↻" title="Storico non configurato" description="Inserisci i valori di acquisto e canone che vuoi proporre durante la registrazione di un device." />}</div>}
{purchaseOrderType === 'licenses' && <div className="panel"><div className="tabs"><button className={licenseOrderSubTab === 'orders' ? 'selected' : ''} onClick={() => setLicenseOrderSubTab('orders')}>Ordini licenze</button><button className={licenseOrderSubTab === 'finance' ? 'selected' : ''} onClick={() => setLicenseOrderSubTab('finance')}>Finance licenze</button></div>
{licenseOrderSubTab === 'orders' && <><div className="panel-heading"><div><h3>Ordini licenze</h3><p>Acquisti di licenze, abbonamenti e rinnovi, separati dai carichi hardware.</p></div><button className="primary-button" onClick={() => { setLicenseOrderForm({ license_name: '', supplier: '', reference: '', purchased_on: '', quantity: '1', unit_cost: '', renewal_on: '', ea_monthly_revenue: '0', ea_monthly_cost: '0', ea_starts_on: '2026-10-01', notes: '' }); setModal('licenseOrder'); }}>＋ Nuovo ordine licenze</button></div>{licenseOrders.length ? <div className="table-panel nested-table"><table><thead><tr><th>Licenza / servizio</th><th>Fornitore / documento</th><th>Data acquisto</th><th>Quantità</th><th>Costo unitario</th><th>Rinnovo</th><th></th></tr></thead><tbody>{licenseOrders.map((order) => <tr key={order.id}><td><strong>{order.license_name}</strong>{order.notes && <small>{order.notes}</small>}</td><td>{order.supplier || '—'}<small>{order.reference || ''}</small></td><td>{date(order.purchased_on)}</td><td>{order.quantity}</td><td>{money(order.unit_cost)}</td><td>{date(order.renewal_on)}</td><td><div className="table-actions"><button className="secondary-button" onClick={() => { setLicenseOrderForm({ license_name: order.license_name || '', supplier: order.supplier || '', reference: order.reference || '', purchased_on: order.purchased_on ? String(order.purchased_on).slice(0,10) : '', quantity: String(order.quantity || 1), unit_cost: order.unit_cost ?? '', renewal_on: order.renewal_on ? String(order.renewal_on).slice(0,10) : '', ea_starts_on: String(order.ea_starts_on || '2026-10-01').slice(0,10), notes: order.notes || '' }); setModal('editLicenseOrder:' + order.id); }}>Modifica</button><button className="secondary-button" disabled={busy} onClick={() => deleteLicenseOrder(order)}>Elimina</button></div></td></tr>)}</tbody></table></div> : <EmptyState icon="▤" title="Nessun ordine licenze" description="Registra qui licenze software, abbonamenti e rinnovi senza mescolarli con l’inventario hardware." />}</>}
{licenseOrderSubTab === 'finance' && <><div className="panel-heading"><div><h3>Finance licenze</h3><p>Contatori aggiornati automaticamente dai dati degli ordini licenze. Seleziona un ordine per vedere soltanto i suoi valori.</p></div></div>{licenseFinanceRows.length ? <><div className="form-grid"><label className="field"><span>Ordine licenze</span><select value={licenseFinanceRows.some((row) => String(row.id) === String(selectedLicenseFinanceOrderId)) ? String(selectedLicenseFinanceOrderId) : String(licenseFinanceRows[0].id)} onChange={(event) => setSelectedLicenseFinanceOrderId(event.target.value)}>{licenseFinanceRows.map((row) => <option key={row.id} value={String(row.id)}>{row.license_name}{row.reference ? ' · ' + row.reference : ''}</option>)}</select></label></div>{(() => { const row = licenseFinanceRows.find((item) => String(item.id) === String(selectedLicenseFinanceOrderId)) || licenseFinanceRows[0]; return <><div className="panel-heading"><div><h4>{row.license_name}</h4><p>{Number(row.active_branches_now || 0)} filiali attive · {money(row.monthly_revenue_now || 0)} di ricavi EA al mese</p></div></div><div className="stats-grid finance-stats"><StatCard label="Investimento licenze" value={money(row.investment_cost)} caption="Costo totale dell'ordine selezionato" icon="€" tone="amber" /><StatCard label="Recuperato a oggi" value={row.term_complete ? money(row.recovered_to_date) : '—'} caption={row.recovery_percent == null ? 'Periodo EA da verificare' : row.recovery_percent.toFixed(1) + '% dell’investimento recuperato'} icon="↗" tone="green" /><StatCard label="Da recuperare" value={row.term_complete ? money(row.amount_to_recover) : '—'} caption="Investimento residuo da recuperare" icon="↻" tone="violet" /><StatCard label="Margine previsto" value={row.term_complete ? money(row.projected_margin) : '—'} caption={row.break_even_date ? 'Rientro previsto: ' + date(row.break_even_date) : row.term_complete ? 'Rientro non previsto nel periodo EA' : 'Inserisci decorrenza e scadenza EA'} icon="€" tone={Number(row.projected_margin || 0) >= 0 ? 'green' : 'amber'} /></div></>; })()}</> : <EmptyState icon="€" title="Nessun ordine da analizzare" description="Registra un ordine licenze per visualizzare automaticamente i contatori finanziari." />}</>}
</div>}

{purchaseOrderType === 'global' && <div className="panel"><div className="panel-heading"><div><h3>Canoni globali</h3><p>Canone mensile commerciale per filiale, con decorrenza e durata configurabili.</p></div><button className="primary-button" onClick={() => { setGlobalChargeForm({ description: '', monthly_amount: '', license_order_id: '', starts_on: new Date().getFullYear() + '-10-01', duration_months: '60', apply_to_all: false, branch_ids: [] }); setModal('globalCharge'); }}>＋ Nuovo canone</button></div>{globalCharges.length ? <div className="table-panel nested-table"><table><thead><tr><th>Descrizione</th><th>Ordine EA collegato</th><th>Canone mensile / filiale</th><th>Decorrenza</th><th>Durata</th><th>Filiali</th><th></th></tr></thead><tbody>{globalCharges.map((charge) => <tr key={charge.id}><td><strong>{charge.description}</strong></td><td>{licenseOrders.find((order) => String(order.id) === String(charge.license_order_id))?.license_name || '—'}</td><td>{money(charge.monthly_amount)}</td><td>{date(charge.starts_on)}</td><td>{charge.duration_months} mesi</td><td>{charge.apply_to_all ? 'Tutte le filiali' : branches.filter((branch) => (charge.branch_ids || []).map(String).includes(String(branch.id))).map((branch) => branch.nomenclature || branch.street).join(', ') || '—'}</td><td><div className="table-actions"><button className="secondary-button" onClick={() => { setGlobalChargeForm({ description: charge.description || '', monthly_amount: String(charge.monthly_amount ?? ''), license_order_id: charge.license_order_id ? String(charge.license_order_id) : '', starts_on: String(charge.starts_on).slice(0,10), duration_months: String(charge.duration_months || 60), apply_to_all: Boolean(charge.apply_to_all), branch_ids: (charge.branch_ids || []).map(String) }); setModal('editGlobalCharge:' + charge.id); }}>Modifica</button><button className="secondary-button" disabled={busy} onClick={() => deleteGlobalCharge(charge)}>Elimina</button></div></td></tr>)}</tbody></table></div> : <EmptyState icon="€" title="Nessun canone globale" description="Crea un canone mensile per tutte le filiali o seleziona quelle interessate dal menu." />}</div>}
</section>}{adminTab === 'users' && user.role === 'admin' && <div className="panel"><div className="panel-heading"><div><h3>Utenti e ruoli</h3><p>Accessi individuali al workspace</p></div><button className="primary-button" onClick={() => { setUserForm({ username: '', display_name: '', password: '', role: 'technician' }); setModal('user'); }}>＋ Nuovo utente</button></div>{users.length ? <div className="table-panel nested-table"><table><thead><tr><th>Utente</th><th>Username</th><th>Ruolo</th><th>Stato</th></tr></thead><tbody>{users.map((item) => <tr key={item.id}><td><strong>{item.display_name}</strong></td><td>{item.username}</td><td><span className="soft-tag">{item.role}</span></td><td>{item.is_active ? 'Attivo' : 'Disattivato'}</td></tr>)}</tbody></table></div> : <EmptyState icon="♙" title="Nessun utente" description="Configura un utente amministratore tramite le variabili server per iniziare." />}</div>}</section>}
        </div>
      </main>

      {modal === 'branch' && <Modal title="Nuova filiale" subtitle="Inserisci l'anagrafica essenziale; gli altri campi possono essere completati dopo." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/branches', { method: 'POST', body: JSON.stringify(body) }), { ...branchForm, company_id: Number(branchForm.company_id) }); }}><BranchFields form={branchForm} setForm={setBranchForm} companies={companies} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy || !companies.length}>{busy ? 'Salvataggio…' : 'Salva filiale'}</button></div>{!companies.length && <p className="field-hint">Crea prima una ragione sociale in Amministrazione.</p>}</form></Modal>}

      {modal === 'editBranch' && <Modal title="Modifica filiale" subtitle="Aggiorna i dati anagrafici." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/branches/' + selectedBranch.id, { method: 'PUT', body: JSON.stringify(body) }), { ...branchForm, company_id: Number(branchForm.company_id) }).then(() => api('/branches/' + selectedBranch.id).then((result) => setSelectedBranch(result.data))); }}><BranchFields form={branchForm} setForm={setBranchForm} companies={companies} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Salva modifiche</button></div></form></Modal>}

      {modal === 'company' && <Modal title="Nuova ragione sociale" subtitle="La società sarà selezionabile nelle schede filiale." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/companies', { method: 'POST', body: JSON.stringify(body) }), companyForm); }}><label>Ragione sociale<input value={companyForm.legal_name} onChange={(event) => setCompanyForm({ ...companyForm, legal_name: event.target.value })} required maxLength="200" /></label><label>Codice fiscale / P.IVA<input value={companyForm.tax_code} onChange={(event) => setCompanyForm({ ...companyForm, tax_code: event.target.value })} maxLength="50" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Salva ragione sociale</button></div></form></Modal>}

      {(modal === 'model' || modal.startsWith('editModel:')) && <Modal title={modal.startsWith('editModel:') ? 'Modifica prodotto' : 'Nuovo prodotto'} subtitle="Codice SKU e canone mensile NOL di riferimento." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const body={...modelForm,default_purchase_cost:null,default_monthly_fee:modelForm.default_monthly_fee===''?null:Number(modelForm.default_monthly_fee),useful_life_months:null}; const id=modal.startsWith('editModel:')?modal.split(':')[1]:null; submitForm((payload)=>api(id?'/device-models/'+id:'/device-models',{method:id?'PUT':'POST',body:JSON.stringify(payload)}),body); }}><div className="form-grid"><label>Produttore<input value={modelForm.manufacturer} onChange={(event)=>setModelForm({...modelForm,manufacturer:event.target.value})} required /></label><label>Modello / prodotto<input value={modelForm.model_name} onChange={(event)=>setModelForm({...modelForm,model_name:event.target.value})} required /></label><label>SKU / codice prodotto<input value={modelForm.sku} onChange={(event)=>setModelForm({...modelForm,sku:event.target.value})} /></label><label>Categoria<input value={modelForm.category} onChange={(event)=>setModelForm({...modelForm,category:event.target.value})} required /></label><label>Formula predefinita<select value={modelForm.ownership_type} onChange={(event)=>setModelForm({...modelForm,ownership_type:event.target.value})}><option value="sale">DDE / vendita</option><option value="rental">NOL</option></select></label><label>Canone mensile NOL (€)<input type="number" min="0" step="0.01" value={modelForm.default_monthly_fee} onChange={(event)=>setModelForm({...modelForm,default_monthly_fee:event.target.value})} /></label></div><label>Note<textarea rows="3" value={modelForm.notes} onChange={(event)=>setModelForm({...modelForm,notes:event.target.value})} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>{busy?'Salvataggio…':'Salva prodotto'}</button></div></form></Modal>}{(modal === 'device' || modal.startsWith('editDevice:')) && <Modal title={modal.startsWith('editDevice:') ? 'Modifica device' : 'Registra device'} subtitle="Seleziona il modello per caricare i valori predefiniti." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const model = models.find((item) => String(item.id) === String(deviceForm.model_id)); const editId=modal.startsWith('editDevice:')?modal.split(':')[1]:null; const body={...deviceForm,model_id:Number(deviceForm.model_id),purchase_profile_id:deviceForm.purchase_profile_id?Number(deviceForm.purchase_profile_id):null,branch_id:null,stock_location_id:deviceForm.stock_location_id?Number(deviceForm.stock_location_id):null,activated_on:deviceForm.activated_on,installed_on:deviceForm.activated_on,ownership_type:deviceForm.ownership_type||model?.ownership_type||'sale',purchase_cost:deviceForm.purchase_cost===''?(model?.default_purchase_cost??null):Number(deviceForm.purchase_cost),monthly_fee:deviceForm.monthly_fee===''?(model?.default_monthly_fee??null):Number(deviceForm.monthly_fee),sale_price:deviceForm.sale_price===''?null:Number(deviceForm.sale_price)}; submitForm(async(payload)=>{if(editId){const saved=await api('/devices/'+editId,{method:'PUT',body:JSON.stringify({...payload,branch_id:deviceForm.branch_id?Number(deviceForm.branch_id):null})});if(deviceForm.branch_id&&!deviceForm.was_assigned)await api('/devices/'+editId+'/activate',{method:'POST',body:JSON.stringify({branch_id:Number(deviceForm.branch_id),ownership_type:payload.ownership_type,sale_price:payload.sale_price,monthly_fee:payload.monthly_fee,activated_on:deviceForm.activated_on})});else if(!deviceForm.branch_id&&deviceForm.was_assigned)await api('/devices/'+editId+'/deactivate',{method:'POST',body:JSON.stringify({deactivated_on:new Date().toISOString().slice(0,10)})});return saved;}const created=await api('/devices',{method:'POST',body:JSON.stringify(payload)});if(deviceForm.branch_id)await api('/devices/'+created.data.id+'/activate',{method:'POST',body:JSON.stringify({branch_id:Number(deviceForm.branch_id),ownership_type:payload.ownership_type,sale_price:payload.sale_price,monthly_fee:payload.monthly_fee,activated_on:deviceForm.activated_on})});return created;},body); }}><label>Modello<select value={deviceForm.model_id} onChange={(event) => { const model = models.find((item) => String(item.id) === event.target.value); const profile = purchaseProfiles.find((item) => String(item.device_model_id) === event.target.value); setDeviceForm({ ...deviceForm, model_id: event.target.value, purchase_profile_id: profile ? String(profile.id) : '', ownership_type: deviceForm.model_id ? deviceForm.ownership_type : (model?.ownership_type || 'sale'), purchase_cost: profile?.unit_cost ?? model?.default_purchase_cost ?? '', monthly_fee: model?.default_monthly_fee ?? profile?.monthly_fee ?? '' }); }} required><option value="">Seleziona modello</option>{models.map((model) => <option key={model.id} value={model.id}>{model.manufacturer} {model.model_name}</option>)}</select></label><label>Ordine di acquisto<select value={deviceForm.purchase_profile_id} onChange={(event) => { const profile = purchaseProfiles.find((item) => String(item.id) === event.target.value); setDeviceForm({ ...deviceForm, purchase_profile_id: event.target.value, purchase_cost: profile?.unit_cost ?? deviceForm.purchase_cost, monthly_fee: profile?.monthly_fee ?? deviceForm.monthly_fee }); }}><option value="">Valori standard del modello</option>{purchaseProfiles.filter((profile) => String(profile.device_model_id) === String(deviceForm.model_id)).map((profile) => <option key={profile.id} value={profile.id}>{profile.reference || ('Ordine #' + profile.id)} · {profile.supplier || 'Fornitore non indicato'} · {date(profile.purchased_on)} · {money(profile.unit_cost)}</option>)}</select></label><div className="form-grid"><label>Filiale<select value={deviceForm.branch_id} onChange={(event) => setDeviceForm({ ...deviceForm, branch_id: event.target.value, status: event.target.value ? 'operational' : 'in_stock' })}><option value="">A magazzino / non assegnato</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.nomenclature || branch.street} · {branch.company_name}</option>)}</select></label><label>Magazzino di provenienza<select value={deviceForm.stock_location_id} onChange={(event)=>setDeviceForm({...deviceForm,stock_location_id:event.target.value})}><option value="">Seleziona magazzino</option>{locations.map((location)=><option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>Formula attivazione<select value={deviceForm.ownership_type} onChange={(event)=>{const model=models.find((item)=>String(item.id)===String(deviceForm.model_id));const profile=purchaseProfiles.find((item)=>String(item.id)===String(deviceForm.purchase_profile_id));const currentDefault=model?.default_monthly_fee??profile?.monthly_fee;setDeviceForm({...deviceForm,ownership_type:event.target.value,monthly_fee:event.target.value==='rental'?(currentDefault??deviceForm.monthly_fee??''):deviceForm.monthly_fee});}}><option value="sale">DDE / vendita</option><option value="rental">NOL</option></select></label><label>Data attivazione<input type="date" value={deviceForm.activated_on} onChange={(event)=>setDeviceForm({...deviceForm,activated_on:event.target.value})}/></label><label>Prezzo di vendita DDE (€)<input type="number" min="0" step="0.01" value={deviceForm.sale_price} onChange={(event)=>setDeviceForm({...deviceForm,sale_price:event.target.value})}/></label><label>Stato<select value={deviceForm.status} onChange={(event) => setDeviceForm({ ...deviceForm, status: event.target.value })}><option value="in_stock">A magazzino</option><option value="to_activate">Da attivare</option><option value="operational">Operativo</option><option value="fault">Guasto</option><option value="decommissioned">Dismesso</option></select></label><label>Matricola<input value={deviceForm.serial_number} onChange={(event) => setDeviceForm({ ...deviceForm, serial_number: event.target.value })} /></label><label>Costo effettivo lotto (€)<input type="number" min="0" step="0.01" value={deviceForm.purchase_cost} readOnly={Boolean(deviceForm.purchase_profile_id)} onChange={(event) => setDeviceForm({ ...deviceForm, purchase_cost: event.target.value })} /></label><label>Canone mensile NOL (€)<input type="number" min="0" step="0.01" value={deviceForm.monthly_fee} onChange={(event) => setDeviceForm({ ...deviceForm, monthly_fee: event.target.value })} />{deviceForm.ownership_type === 'rental' && (models.find((item) => String(item.id) === String(deviceForm.model_id))?.default_monthly_fee ?? purchaseProfiles.find((item) => String(item.id) === String(deviceForm.purchase_profile_id))?.monthly_fee) == null && <small className="field-hint">Nessun canone NOL predefinito nel catalogo per questo modello: inserisci il valore manualmente.</small>}</label></div><label>Note<textarea rows="3" value={deviceForm.notes} onChange={(event) => setDeviceForm({ ...deviceForm, notes: event.target.value })} /></label><div className="modal-actions">{modal.startsWith('editDevice:') && user.role === 'admin' && <button type="button" className="secondary-button" disabled={busy} onClick={() => deleteDevice(devices.find((device) => String(device.id) === modal.split(':')[1]) || { id: modal.split(':')[1] })}>Elimina device</button>}<button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy || !models.length}>{busy ? 'Salvataggio…' : 'Salva device'}</button></div>{!models.length && <p className="field-hint">Aggiungi prima un modello nel Catalogo device.</p>}</form></Modal>}

      {(modal === 'purchaseProfile' || modal.startsWith('editPurchaseProfile:')) && <Modal title={modal.startsWith('editPurchaseProfile:') ? 'Modifica ordine di acquisto' : 'Nuovo ordine di acquisto'} subtitle={modal.startsWith('editPurchaseProfile:') ? 'Modifica i dati dell’ordine e la quantità disponibile a magazzino.' : 'Il carico quantità avviene subito al salvataggio dell’ordine.'} onClose={() => setModal('')}><form className="form-stack" onSubmit={(event)=>{event.preventDefault();const editId=modal.startsWith('editPurchaseProfile:')?modal.split(':')[1]:null;const body={...profileForm,device_model_id:Number(profileForm.device_model_id),stock_location_id:profileForm.stock_location_id?Number(profileForm.stock_location_id):null,unit_cost:profileForm.unit_cost===''?null:Number(profileForm.unit_cost),quantity:Number(profileForm.quantity||1),monthly_fee:null,useful_life_months:null};submitForm((payload)=>api(editId?'/purchase-profiles/'+editId:'/purchase-profiles',{method:editId?'PUT':'POST',body:JSON.stringify(payload)}),body);}}><div className="tabs"><button type="button" className={purchaseProfileTab === 'details' ? 'selected' : ''} onClick={() => setPurchaseProfileTab('details')}>Dettagli ordine</button><button type="button" className={purchaseProfileTab === 'devices' ? 'selected' : ''} onClick={() => setPurchaseProfileTab('devices')}>Dispositivi utilizzati <span>{devices.filter((device) => String(device.purchase_profile_id) === String(modal.startsWith('editPurchaseProfile:') ? modal.split(':')[1] : '')).length}</span></button></div>{purchaseProfileTab === 'details' && <><label>Prodotto<select disabled={modal.startsWith('editPurchaseProfile:')} value={profileForm.device_model_id} onChange={(event)=>setProfileForm({...profileForm,device_model_id:event.target.value})} required><option value="">Seleziona prodotto</option>{models.map((model)=><option key={model.id} value={model.id}>{model.sku?model.sku+' · ':''}{model.manufacturer} {model.model_name}</option>)}</select></label><div className="form-grid"><label>Fornitore<input value={profileForm.supplier} onChange={(event)=>setProfileForm({...profileForm,supplier:event.target.value})}/></label><label>Numero documento<input value={profileForm.reference} onChange={(event)=>setProfileForm({...profileForm,reference:event.target.value})}/></label><label>Data ordine<input type="date" value={profileForm.purchased_on} onChange={(event)=>setProfileForm({...profileForm,purchased_on:event.target.value})} required/></label><label>Costo unitario effettivo (€)<input type="number" min="0" step="0.01" value={profileForm.unit_cost} onChange={(event)=>setProfileForm({...profileForm,unit_cost:event.target.value})} required/></label><label>Quantità ordinata<input type="number" min="1" step="1" value={profileForm.quantity} onChange={(event)=>setProfileForm({...profileForm,quantity:event.target.value})} required/></label><label>Carica nel magazzino<select value={profileForm.stock_location_id} onChange={(event)=>setProfileForm({...profileForm,stock_location_id:event.target.value})} required><option value="">Seleziona magazzino</option>{locations.map((location)=><option key={location.id} value={location.id}>{location.name}</option>)}</select></label></div><label>Note<textarea rows="3" value={profileForm.notes} onChange={(event)=>setProfileForm({...profileForm,notes:event.target.value})}/></label>{modal.startsWith('editPurchaseProfile:') && <p className="field-hint">Il prodotto non è modificabile; puoi riassegnare il magazzino. La quantità non può scendere sotto il numero di device già prelevati.</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setModal('')}>Annulla</button><button className="primary-button" disabled={busy||!models.length||!locations.length}>{busy?'Salvataggio…':modal.startsWith('editPurchaseProfile:')?'Salva modifiche':'Registra ordine'}</button></div></>}{purchaseProfileTab === 'devices' && <div className="panel"><div className="panel-heading"><div><h3>Dispositivi provenienti dall'ordine</h3><p>Elenco dei device collegati a questo acquisto, con filiale, ubicazione e stato corrente.</p></div><span className="soft-tag">{devices.filter((device) => String(device.purchase_profile_id) === String(modal.startsWith('editPurchaseProfile:') ? modal.split(':')[1] : '')).length} device</span></div><DeviceTable devices={devices.filter((device) => String(device.purchase_profile_id) === String(modal.startsWith('editPurchaseProfile:') ? modal.split(':')[1] : ''))} />{!devices.some((device) => String(device.purchase_profile_id) === String(modal.startsWith('editPurchaseProfile:') ? modal.split(':')[1] : '')) && <EmptyState icon="▣" title="Nessun device collegato" description="Quando registri un device, seleziona questo ordine nel campo Ordine di acquisto." />}</div>}</form></Modal>}{modal === 'user' && <Modal title="Nuovo utente" subtitle="La password iniziale deve contenere almeno 12 caratteri." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/admin/users', { method: 'POST', body: JSON.stringify(body) }), userForm); }}><label>Nome visualizzato<input value={userForm.display_name} onChange={(event) => setUserForm({ ...userForm, display_name: event.target.value })} required /></label><label>Username<input value={userForm.username} onChange={(event) => setUserForm({ ...userForm, username: event.target.value })} required /></label><label>Password iniziale<input type="password" autoComplete="new-password" minLength="12" value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} required /></label><label>Ruolo<select value={userForm.role} onChange={(event) => setUserForm({ ...userForm, role: event.target.value })}><option value="technician">Tecnico</option><option value="sales">Commerciale</option><option value="warehouse">Magazzino</option><option value="finance">Finance</option><option value="admin">Amministratore</option></select></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Crea utente</button></div></form></Modal>}

      {modal === 'checklist' && <Modal title="Nuova checklist" subtitle="Inserisci una voce per riga." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/branches/' + selectedBranch.id + '/checklists', { method: 'POST', body: JSON.stringify(body) }), { title: checklistForm.title, items: checklistForm.items.split('\n').map((item) => item.trim()).filter(Boolean) }).then(() => api('/branches/' + selectedBranch.id + '/checklists').then((result) => setChecklists(result.data))); }}><label>Titolo<input value={checklistForm.title} onChange={(event) => setChecklistForm({ ...checklistForm, title: event.target.value })} required /></label><label>Voci checklist<textarea rows="6" value={checklistForm.items} onChange={(event) => setChecklistForm({ ...checklistForm, items: event.target.value })} required /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Crea checklist</button></div></form></Modal>}

      {(modal === 'location' || modal.startsWith('editLocation:')) && <Modal title={modal === 'location' ? 'Nuova ubicazione' : 'Modifica magazzino'} onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const editId = modal.startsWith('editLocation:') ? modal.split(':')[1] : null; submitForm((body) => api(editId ? '/stock/locations/' + editId : '/stock/locations', { method: editId ? 'PUT' : 'POST', body: JSON.stringify(body) }), locationForm); }}><label>Nome magazzino<input value={locationForm.name} onChange={(event) => setLocationForm({ ...locationForm, name: event.target.value })} required /></label><label>Indirizzo<input value={locationForm.address} onChange={(event) => setLocationForm({ ...locationForm, address: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>{busy ? 'Salvataggio…' : 'Salva modifiche'}</button></div></form></Modal>}

      {(modal === 'licenseOrder' || modal.startsWith('editLicenseOrder:')) && <Modal title={modal.startsWith('editLicenseOrder:') ? 'Modifica ordine licenze' : 'Nuovo ordine licenze'} subtitle="Registra acquisti di licenze e rinnovi, separati dagli ordini hardware." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const editId = modal.startsWith('editLicenseOrder:') ? modal.split(':')[1] : null; const body = { ...licenseOrderForm, quantity: Number(licenseOrderForm.quantity || 1), unit_cost: licenseOrderForm.unit_cost === '' ? null : Number(licenseOrderForm.unit_cost), ea_starts_on: licenseOrderForm.ea_starts_on }; submitForm((payload) => api(editId ? '/license-purchase-orders/' + editId : '/license-purchase-orders', { method: editId ? 'PUT' : 'POST', body: JSON.stringify(payload) }), body); }}><label>Licenza / servizio<input value={licenseOrderForm.license_name} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, license_name: event.target.value })} required /></label><div className="form-grid"><label>Fornitore<input value={licenseOrderForm.supplier} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, supplier: event.target.value })} /></label><label>Numero documento<input value={licenseOrderForm.reference} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, reference: event.target.value })} /></label><label>Data acquisto<input type="date" value={licenseOrderForm.purchased_on} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, purchased_on: event.target.value })} /></label><label>Quantità<input type="number" min="1" step="1" value={licenseOrderForm.quantity} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, quantity: event.target.value })} required /></label><label>Costo unitario (€)<input type="number" min="0" step="0.01" value={licenseOrderForm.unit_cost} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, unit_cost: event.target.value })} /></label><label>Data rinnovo / scadenza<input type="date" value={licenseOrderForm.renewal_on} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, renewal_on: event.target.value })} /></label><label>Decorrenza canoni EA<input type="date" value={licenseOrderForm.ea_starts_on} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, ea_starts_on: event.target.value })} required /></label></div><p className="field-hint">Il canone mensile EA si configura in “Canoni globali”, collegando questo ordine. Finance utilizza quel valore e conserva lo storico mensile.</p><label>Note<textarea rows="3" value={licenseOrderForm.notes} onChange={(event) => setLicenseOrderForm({ ...licenseOrderForm, notes: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>{busy ? 'Salvataggio…' : 'Salva ordine licenze'}</button></div></form></Modal>}

      {(modal === 'globalCharge' || modal.startsWith('editGlobalCharge:')) && <Modal title={modal.startsWith('editGlobalCharge:') ? 'Modifica canone globale' : 'Nuovo canone globale'} subtitle="Il canone è un ricavo mensile per ogni filiale selezionata." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const editId = modal.startsWith('editGlobalCharge:') ? modal.split(':')[1] : null; const body = { ...globalChargeForm, monthly_amount: Number(globalChargeForm.monthly_amount), license_order_id: globalChargeForm.license_order_id ? Number(globalChargeForm.license_order_id) : null, duration_months: Number(globalChargeForm.duration_months || 60), branch_ids: globalChargeForm.branch_ids.map(Number) }; submitForm((payload) => api(editId ? '/global-monthly-charges/' + editId : '/global-monthly-charges', { method: editId ? 'PUT' : 'POST', body: JSON.stringify(payload) }), body); }}><label>Descrizione<input value={globalChargeForm.description} onChange={(event) => setGlobalChargeForm({ ...globalChargeForm, description: event.target.value })} required /></label><div className="form-grid"><label>Canone mensile per filiale (€)<input type="number" min="0" step="0.01" value={globalChargeForm.monthly_amount} onChange={(event) => setGlobalChargeForm({ ...globalChargeForm, monthly_amount: event.target.value })} required /></label><label>Ordine licenze EA collegato<select value={globalChargeForm.license_order_id} onChange={(event) => setGlobalChargeForm({ ...globalChargeForm, license_order_id: event.target.value })}><option value="">Nessun collegamento</option>{licenseOrders.map((order) => <option key={order.id} value={String(order.id)}>{order.license_name} — {money(Number(order.unit_cost || 0) * Number(order.quantity || 1))}</option>)}</select></label><label>Data di decorrenza<input type="date" value={globalChargeForm.starts_on} onChange={(event) => setGlobalChargeForm({ ...globalChargeForm, starts_on: event.target.value })} required /></label><label>Durata (mesi)<input type="number" min="1" max="600" step="1" value={globalChargeForm.duration_months} onChange={(event) => setGlobalChargeForm({ ...globalChargeForm, duration_months: event.target.value })} required /></label></div><label className="checkbox-label"><input type="checkbox" checked={globalChargeForm.apply_to_all} onChange={(event) => setGlobalChargeForm({ ...globalChargeForm, apply_to_all: event.target.checked })} /> Applica a tutte le filiali</label>{!globalChargeForm.apply_to_all && <label>Filiali interessate <span className="muted">(usa Ctrl o Cmd per selezionarne più di una)</span><select multiple size="7" value={globalChargeForm.branch_ids} onChange={(event) => setGlobalChargeForm({ ...globalChargeForm, branch_ids: Array.from(event.target.selectedOptions, (option) => option.value) })} required>{branches.map((branch) => <option key={branch.id} value={String(branch.id)}>{branch.company_name ? branch.company_name + ' — ' : ''}{branch.nomenclature || branch.street || ('Filiale ' + branch.id)}</option>)}</select></label>}<p className="muted">Il canone viene conteggiato come ricavo mensile per ogni filiale destinataria, dalla decorrenza fino alla scadenza.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>{busy ? 'Salvataggio…' : 'Salva canone'}</button></div></form></Modal>}

      {modal === 'importDevices' && <Modal title="Importa device da CSV" subtitle="Associa ogni riga a un modello e a una filiale già presenti. Non verranno create nuove ragioni sociali o filiali." onClose={() => setModal('')}><div className="import-preview"><p className="field-hint">Righe da importare: {deviceImportRows.length}. Se una filiale non è stata riconosciuta automaticamente, selezionala manualmente. Le righe con modello non riconosciuto richiedono una selezione manuale.</p><div className="table-panel import-table"><table><thead><tr><th>Riga / SKU</th><th>Modello</th><th>Ragione sociale / filiale</th><th>Assegnazione manuale</th><th>Contratto</th></tr></thead><tbody>{deviceImportRows.map((row, index) => <tr key={row.rowNumber}><td><strong>#{row.rowNumber}</strong><small>{row.sku || row.serial || 'SKU assente'}</small></td><td><select value={row.model_id} onChange={(event) => setDeviceImportRows((current) => current.map((item, i) => i === index ? { ...item, model_id: event.target.value, model_missing: !event.target.value } : item))}><option value="">Seleziona modello…</option>{models.map((model) => <option key={model.id} value={String(model.id)}>{model.sku ? model.sku + ' · ' : ''}{model.manufacturer} {model.model_name}</option>)}</select>{row.model_missing && <small className="import-warning">Modello da associare</small>}</td><td>{row.companyName || '—'}<small>{row.branchName}</small></td><td><select value={row.branch_id} onChange={(event) => setDeviceImportRows((current) => current.map((item, i) => i === index ? { ...item, branch_id: event.target.value, branch_missing: !event.target.value } : item))}><option value="">Seleziona filiale…</option>{branches.map((branch) => <option key={branch.id} value={String(branch.id)}>{branch.company_name} — {branch.nomenclature || branch.street}</option>)}</select>{row.branch_missing && <small className="import-warning">Filiale da associare</small>}</td><td>{row.contract || '—'}</td></tr>)}</tbody></table></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button type="button" className="primary-button" disabled={busy || deviceImportRows.some((row) => !row.model_id || !row.branch_id)} onClick={executeDeviceImport}>{busy ? 'Importazione…' : 'Importa dispositivi'}</button></div></div></Modal>}

      {modal === 'bulkDevices' && <Modal title="Modifica massiva device" subtitle="Scegli le filiali, il campo e il nuovo valore. Solo il campo selezionato verrà modificato." onClose={() => setModal('')}>
        <form className="form-stack" onSubmit={submitBulkDeviceUpdate}>
          <label>Filiali interessate
            <select multiple size="6" value={bulkBranchIds} onChange={(event) => setBulkBranchIds(Array.from(event.target.selectedOptions, (option) => option.value))}>
              {branches.map((branch) => <option key={branch.id} value={String(branch.id)}>{branch.company_name} — {branch.nomenclature || branch.street || ('Filiale #' + branch.id)}</option>)}
            </select>
            <p className="field-hint">{bulkBranchIds.length ? bulkBranchIds.length + ' filiali selezionate.' : 'Nessuna selezione: verranno considerate tutte le filiali.'} Per selezionare più filiali usa Ctrl (Windows) o Cmd (Mac).</p>
          </label>
          <label>Campo da modificare
            <select value={bulkField} onChange={(event) => { setBulkField(event.target.value); setBulkValue(event.target.value === 'status' ? 'to_activate' : ''); }} required>
              <option value="activated_on">Data attivazione</option>
              <option value="status">Stato</option>
              <option value="purchase_profile_id">Ordine di provenienza</option>
              <option value="stock_location_id">Magazzino di provenienza</option>
            </select>
          </label>
          {bulkField === 'activated_on' && <label>Nuova data di attivazione<input type="date" value={bulkValue} onChange={(event) => setBulkValue(event.target.value)} /><p className="field-hint">Lascia vuoto per cancellare la data di attivazione.</p></label>}
          {bulkField === 'status' && <label>Nuovo stato<select value={bulkValue} onChange={(event) => setBulkValue(event.target.value)} required><option value="in_stock">A magazzino</option><option value="to_activate">Da attivare</option><option value="operational">Operativo</option><option value="fault">Guasto</option><option value="decommissioned">Dismesso</option></select></label>}
          {bulkField === 'purchase_profile_id' && <label>Ordine di provenienza<select value={bulkValue} onChange={(event) => setBulkValue(event.target.value)}><option value="">Nessun ordine</option>{purchaseProfiles.map((profile) => <option key={profile.id} value={String(profile.id)}>{[profile.reference, profile.supplier, profile.manufacturer, profile.model_name].filter(Boolean).join(' · ') || ('Ordine #' + profile.id)}</option>)}</select></label>}
          {bulkField === 'stock_location_id' && <label>Magazzino di provenienza<select value={bulkValue} onChange={(event) => setBulkValue(event.target.value)}><option value="">Nessun magazzino</option>{locations.map((location) => <option key={location.id} value={String(location.id)}>{location.name}</option>)}</select></label>}
          <div className="panel bulk-preview">
            <strong>{bulkDevices.filter((device) => device.branch_id != null && (!bulkBranchIds.length || bulkBranchIds.includes(String(device.branch_id)))).length} device nelle filiali selezionate</strong>
            <p className="field-hint">{bulkDevices.filter((device) => device.branch_id != null && (!bulkBranchIds.length || bulkBranchIds.includes(String(device.branch_id))) && String((bulkField === 'activated_on' ? String(device.activated_on || device.installed_on || '').slice(0, 10) : device[bulkField]) ?? '') !== String(bulkValue ?? '')).length} device verranno modificati con il valore scelto.</p>
          </div>
          <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setModal('')}>Annulla</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Aggiornamento…' : 'Conferma modifica'}</button></div>
        </form>
      </Modal>}
      {modal === 'movement' && <Modal title="Registra movimento" subtitle="Il movimento aggiorna anche assegnazione e stato del device." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/stock/movements', { method: 'POST', body: JSON.stringify(body) }), { ...movementForm, device_id: Number(movementForm.device_id), from_location_id: movementForm.from_location_id ? Number(movementForm.from_location_id) : null, to_location_id: movementForm.to_location_id ? Number(movementForm.to_location_id) : null, branch_id: movementForm.branch_id ? Number(movementForm.branch_id) : null }); }}><label>Dispositivo<select value={movementForm.device_id} onChange={(event) => setMovementForm({ ...movementForm, device_id: event.target.value })} required><option value="">Seleziona device</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.manufacturer} {device.model_name} · {device.asset_tag || 'senza tag'}</option>)}</select></label><label>Tipo movimento<input value={movementForm.movement_type} onChange={(event) => setMovementForm({ ...movementForm, movement_type: event.target.value })} required /></label><div className="form-grid"><label>Da ubicazione<select value={movementForm.from_location_id} onChange={(event) => setMovementForm({ ...movementForm, from_location_id: event.target.value })}><option value="">—</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>A ubicazione<select value={movementForm.to_location_id} onChange={(event) => setMovementForm({ ...movementForm, to_location_id: event.target.value })}><option value="">—</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>Filiale di destinazione<select value={movementForm.branch_id} onChange={(event) => setMovementForm({ ...movementForm, branch_id: event.target.value })}><option value="">Nessuna</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.nomenclature || branch.street}</option>)}</select></label></div><label>Note<textarea rows="2" value={movementForm.notes} onChange={(event) => setMovementForm({ ...movementForm, notes: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Registra movimento</button></div></form></Modal>}
    </div>
  );
}

function BranchFields({ form, setForm, companies }) {
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  return <>
    <label>Ragione sociale<select value={form.company_id} onChange={(event) => update('company_id', event.target.value)} required><option value="">Seleziona società</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.legal_name}</option>)}</select></label>
    <div className="form-grid"><label>Stato filiale<select value={form.is_active === true ? 'true' : form.is_active === false ? 'false' : form.is_active} onChange={(event) => update('is_active', event.target.value === 'true' ? true : event.target.value === 'false' ? false : '')} required><option value="">Seleziona stato</option><option value="true">Attiva</option><option value="false">Non attiva</option></select></label><label>Decorrenza stato<input type="date" value={form.active_since || ''} onChange={(event) => update('active_since', event.target.value)} required /></label></div>
    <div className="form-grid"><label>Paese<input value={form.country} onChange={(event) => update('country', event.target.value)} required /></label><label>Via<input value={form.street} onChange={(event) => update('street', event.target.value)} required /></label><label>Nomenclatura<input value={form.nomenclature} onChange={(event) => update('nomenclature', event.target.value)} /></label><label>Vecchia nomenclatura<input value={form.previous_nomenclature} onChange={(event) => update('previous_nomenclature', event.target.value)} /></label><label>Network<input value={form.network} onChange={(event) => update('network', event.target.value)} placeholder="Es. LAN / MPLS" /></label><label>Phone Prefix<input value={form.phone_prefix} onChange={(event) => update('phone_prefix', event.target.value)} /></label><label className="span-two">WLC<input value={form.wlc} onChange={(event) => update('wlc', event.target.value)} /></label></div>
  </>;
}

function DeviceTable({ devices, onEdit }) {
  if (!devices.length) return null;
  const labels = { in_stock: 'A magazzino', to_activate: 'Da attivare', operational: 'Operativo', fault: 'Guasto', decommissioned: 'Dismesso' };
  return <div className="table-panel nested-table"><table><thead><tr><th>SKU / dispositivo</th><th>Matricola</th><th>Filiale / ubicazione</th><th>Formula / stato</th><th>Valore</th><th /></tr></thead><tbody>{devices.map((device) => <tr key={device.id}><td><strong>{device.sku || '—'}</strong><small>{device.manufacturer} {device.model_name}</small></td><td>{device.serial_number || '—'}</td><td>{device.branch_nomenclature || device.stock_location || 'Non assegnato'}<small>{device.company_name || ''}</small></td><td><span className={'status-pill status-' + device.status}>{labels[device.status] || device.status}</span><small>{device.ownership_type === 'rental' ? 'NOL' : 'DDE'}</small></td><td>{device.ownership_type === 'rental' ? money(device.monthly_fee)+'/mese' : money(device.sale_price)}</td><td>{onEdit && <button className="row-action" onClick={() => onEdit(device)}>Modifica</button>}</td></tr>)}</tbody></table></div>;
}
