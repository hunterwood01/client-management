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
  previous_nomenclature: '', network: '', phone_prefix: '', wlc: ''
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
  const [models, setModels] = useState([]);
  const [purchaseProfiles, setPurchaseProfiles] = useState([]);
  const [locations, setLocations] = useState([]);
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
  const [modelForm, setModelForm] = useState({ manufacturer: '', model_name: '', category: 'Collaboration', ownership_type: 'sale', default_purchase_cost: '', default_monthly_fee: '', useful_life_months: '', notes: '' });
  const [profileForm, setProfileForm] = useState({ device_model_id: '', supplier: '', reference: '', purchased_on: '', unit_cost: '', monthly_fee: '', useful_life_months: '', notes: '' });
  const [deviceForm, setDeviceForm] = useState({ model_id: '', purchase_profile_id: '', branch_id: '', asset_tag: '', serial_number: '', status: 'in_stock', ownership_type: 'sale', purchase_cost: '', monthly_fee: '', notes: '' });
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
        api('/device-models'), api('/purchase-profiles'), api('/stock/locations'), api('/stock/movements'),
        api('/dashboard' + (branchFilter === 'all' ? '' : '?branchId=' + branchFilter)),
        api('/finance/dashboard' + (branchFilter === 'all' ? '' : '?branchId=' + branchFilter))
      ]);
      setBranches(results[0].data); setCompanies(results[1].data); setDevices(results[2].data);
      setModels(results[3].data); setPurchaseProfiles(results[4].data); setLocations(results[5].data); setMovements(results[6].data);
      setDashboard(results[7].data); setFinance(results[8].data);
      if (user.role === 'admin') {
        const userResult = await api('/admin/users');
        setUsers(userResult.data);
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
  const filteredBranches = useMemo(() => branches.filter((branch) => [branch.company_name, branch.country, branch.street, branch.network, branch.nomenclature].join(' ').toLowerCase().includes(search.toLowerCase())), [branches, search]);
  const filteredDevices = useMemo(() => devices.filter((device) => [device.manufacturer, device.model_name, device.asset_tag, device.serial_number, device.branch_nomenclature, device.company_name].join(' ').toLowerCase().includes(search.toLowerCase())), [devices, search]);

  async function refresh() { await loadData(); }

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

          {page === 'dashboard' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">PANORAMICA</p><h2>Buongiorno, {user.display_name.split(' ')[0]}.</h2><p className="muted">Ecco la situazione attuale del tuo workspace.</p></div><button className="secondary-button" onClick={refresh}>↻ Aggiorna</button></div><div className="stats-grid"><StatCard label="Filiali" value={dashboard?.branches ?? '—'} caption="Sedi registrate" icon="⌂" /><StatCard label="Device" value={dashboard?.devices ?? '—'} caption="Apparati censiti" icon="▣" tone="violet" /><StatCard label="Da verificare" value={dashboard?.faults ?? '—'} caption="Device in stato guasto" icon="!" tone="amber" /><StatCard label="Canoni mensili" value={money(dashboard?.monthlyFees)} caption="Valore mensile registrato" icon="€" tone="green" /></div><div className="dashboard-grid"><section className="panel"><div className="panel-heading"><div><h3>Attività operative</h3><p>Riepilogo del parco device</p></div><button className="text-button" onClick={() => setPage('devices')}>Vedi device →</button></div><div className="activity-list"><div className="activity-row"><span className="activity-icon blue">▣</span><div><strong>Dispositivi a magazzino</strong><small>Disponibili per assegnazione</small></div><b>{dashboard?.stock ?? '—'}</b></div><div className="activity-row"><span className="activity-icon amber">!</span><div><strong>Dispositivi guasti</strong><small>Richiedono una verifica</small></div><b>{dashboard?.faults ?? '—'}</b></div><div className="activity-row"><span className="activity-icon green">€</span><div><strong>Canoni mensili</strong><small>Somma dei canoni dei device</small></div><b>{money(dashboard?.monthlyFees)}</b></div></div></section><section className="panel quick-panel"><div className="panel-heading"><div><h3>Accesso rapido</h3><p>Le azioni più utilizzate</p></div></div><button className="quick-action" onClick={() => setModal('branch')}><span className="quick-icon">＋</span><span><strong>Nuova filiale</strong><small>Aggiungi una sede al workspace</small></span><span className="quick-arrow">→</span></button><button className="quick-action" onClick={() => setModal('device')}><span className="quick-icon purple">▣</span><span><strong>Registra device</strong><small>Inserisci un nuovo apparato</small></span><span className="quick-arrow">→</span></button><button className="quick-action" onClick={() => { setPage('admin'); setAdminTab('models'); }}><span className="quick-icon green">⌘</span><span><strong>Catalogo modelli</strong><small>Gestisci i valori precompilati</small></span><span className="quick-arrow">→</span></button></section></div></section>}

          {page === 'branches' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">ANAGRAFICA</p><h2>Le tue filiali</h2><p className="muted">Anagrafica delle filiali: ragione sociale, nuova nomenclatura, paese, indirizzo, prefisso, LAN e WLC.</p></div><div className="page-actions"><label className="secondary-button file-import-button">Importa CSV NETWORK<input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) importNetworkCsv(file); event.target.value = ''; }} /></label><button className="primary-button" onClick={() => { setBranchForm(emptyBranch); setModal('branch'); }}>＋ Nuova filiale</button></div></div><div className="toolbar"><label className="search-box"><span>⌕</span><input placeholder="Cerca ragione sociale, paese, indirizzo, network…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="result-count">{filteredBranches.length} filiali</span></div><div className="table-panel"><table><thead><tr><th>Ragione sociale</th><th>Paese</th><th>Indirizzo</th><th>Prefisso</th><th>LAN</th><th>WLC</th><th /></tr></thead><tbody>{filteredBranches.map((branch) => <tr key={branch.id} onClick={() => openBranch(branch)} className="clickable-row"><td><strong>{branch.company_name}</strong><small>{branch.nomenclature || 'Nomenclatura non impostata'}</small></td><td>{branch.country || '—'}</td><td>{branch.street || '—'}</td><td>{branch.phone_prefix || '—'}</td><td><span className="soft-tag">{branch.network || '—'}</span></td><td>{branch.wlc || '—'}</td><td><button className="row-action" onClick={(event) => { event.stopPropagation(); openBranch(branch); }}>Apri →</button></td></tr>)}</tbody></table>{!filteredBranches.length && <EmptyState icon="⌂" title="Nessuna filiale presente" description="Crea una filiale per iniziare a organizzare il workspace." />}</div></section>}

          {page === 'branchDetail' && selectedBranch && <section className="page-content"><button className="back-link" onClick={() => setPage('branches')}>← Torna alle filiali</button><div className="detail-heading"><div className="branch-emblem">⌂</div><div><p className="eyebrow">SCHEDA FILIALE</p><h2>{selectedBranch.nomenclature || selectedBranch.street}</h2><p className="muted">{selectedBranch.company_name} · {selectedBranch.country} · {selectedBranch.street}</p></div><button className="secondary-button" onClick={() => { setBranchForm({ company_id: String(selectedBranch.company_id), country: selectedBranch.country || '', street: selectedBranch.street || '', nomenclature: selectedBranch.nomenclature || '', previous_nomenclature: selectedBranch.previous_nomenclature || '', network: selectedBranch.network || '', phone_prefix: selectedBranch.phone_prefix || '', wlc: selectedBranch.wlc || '' }); setModal('editBranch'); }}>Modifica anagrafica</button></div><div className="tabs"><button className={branchTab === 'details' ? 'selected' : ''} onClick={() => setBranchTab('details')}>Anagrafica</button><button className={branchTab === 'devices' ? 'selected' : ''} onClick={() => setBranchTab('devices')}>Devices <span>{devices.filter((device) => String(device.branch_id) === String(selectedBranch.id)).length}</span></button><button className={branchTab === 'checklist' ? 'selected' : ''} onClick={() => setBranchTab('checklist')}>Check-list</button><button className={branchTab === 'companyHistory' ? 'selected' : ''} onClick={() => setBranchTab('companyHistory')}>Storico ragione sociale</button></div>{branchTab === 'details' && <div className="detail-grid">{[['Ragione sociale', selectedBranch.company_name], ['Paese', selectedBranch.country], ['Indirizzo', selectedBranch.street], ['Nomenclatura', selectedBranch.nomenclature], ['Vecchia nomenclatura', selectedBranch.previous_nomenclature], ['Network', selectedBranch.network], ['Phone Prefix', selectedBranch.phone_prefix], ['WLC', selectedBranch.wlc]].map(([label, value]) => <article className="detail-field" key={label}><span>{label}</span><strong>{value || '—'}</strong></article>)}</div>}{branchTab === 'devices' && <div className="panel"><div className="panel-heading"><div><h3>Device installati</h3><p>Apparati associati a questa filiale</p></div><button className="primary-button" onClick={() => { setDeviceForm((form) => ({ ...form, branch_id: String(selectedBranch.id), status: 'operational' })); setModal('device'); }}>＋ Aggiungi device</button></div><DeviceTable devices={devices.filter((device) => String(device.branch_id) === String(selectedBranch.id))} />{!devices.some((device) => String(device.branch_id) === String(selectedBranch.id)) && <EmptyState icon="▣" title="Nessun device installato" description="Aggiungi il primo dispositivo a questa filiale." />}</div>}{branchTab === 'companyHistory' && <div className="panel"><div className="panel-heading"><div><h3>Storico ragione sociale</h3><p>Traccia i cambi di società associata a questa filiale.</p></div></div>{companyHistory.length ? <div className="history-list">{companyHistory.map((item) => <article className="history-entry" key={item.id}><div className="history-marker" /><div className="history-entry-content"><strong>{item.from_company_name} <span>→</span> {item.to_company_name}</strong><p>{new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.changed_at))} · Modifica di {item.changed_by || 'Utente non disponibile'}</p></div></article>)}</div> : <EmptyState icon="↔" title="Nessun cambio registrato" description="Quando la ragione sociale associata alla filiale passerà, ad esempio, da AFIS a IDRAS, il cambiamento comparirà qui." />}</div>}{branchTab === 'checklist' && <div className="panel"><div className="panel-heading"><div><h3>Check-list operative</h3><p>Controlli e attività della filiale</p></div><button className="primary-button" onClick={() => setModal('checklist')}>＋ Nuova checklist</button></div>{checklists.map((checklist) => <div className="checklist-card" key={checklist.id}><div className="checklist-card-heading"><strong>{checklist.title}</strong><span className={'soft-tag ' + (checklist.status === 'completed' ? 'green-tag' : '')}>{checklist.status === 'completed' ? 'Completata' : 'Aperta'}</span></div>{checklist.items.map((item) => <label className="checklist-item" key={item.id}><input type="checkbox" checked={item.is_checked} onChange={async (event) => { try { await api('/checklist-items/' + item.id, { method: 'PATCH', body: JSON.stringify({ is_checked: event.target.checked }) }); const result = await api('/branches/' + selectedBranch.id + '/checklists'); setChecklists(result.data); } catch (err) { setError(err.message); } }} /><span>{item.label}</span></label>)}</div>)}{!checklists.length && <EmptyState icon="☷" title="Nessuna checklist" description="Crea una checklist per registrare le verifiche operative." />}</div>}</section>}

          {page === 'devices' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">INVENTARIO</p><h2>Parco device</h2><p className="muted">Inventario centralizzato degli apparati e delle loro assegnazioni.</p></div><button className="primary-button" onClick={() => setModal('device')}>＋ Registra device</button></div><div className="toolbar"><label className="search-box"><span>⌕</span><input placeholder="Cerca modello, matricola, filiale…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="result-count">{filteredDevices.length} dispositivi</span></div><div className="table-panel"><DeviceTable devices={filteredDevices} onEdit={(device) => { setDeviceForm({ model_id: String(device.model_id), purchase_profile_id: device.purchase_profile_id ? String(device.purchase_profile_id) : '', branch_id: device.branch_id ? String(device.branch_id) : '', asset_tag: device.asset_tag || '', serial_number: device.serial_number || '', status: device.status, ownership_type: device.ownership_type, purchase_cost: device.purchase_cost ?? '', monthly_fee: device.monthly_fee ?? '', notes: device.notes || '' }); setModal('editDevice:' + device.id); }} />{!filteredDevices.length && <EmptyState icon="▣" title="Nessun dispositivo trovato" description="Registra un dispositivo oppure modifica i filtri di ricerca." />}</div></section>}

          {page === 'finance' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">PANORAMICA ECONOMICA</p><h2>Finance dashboard</h2><p className="muted">Riepilogo economico del parco dispositivi. Le altre funzioni Finance saranno aggiunte in una fase successiva.</p></div><span className="soft-tag">Dashboard</span></div><div className="stats-grid finance-stats"><StatCard label="Device censiti" value={finance?.devices ?? '—'} caption="Nel perimetro selezionato" icon="▣" /><StatCard label="Valore acquisti" value={money(finance?.purchase_cost)} caption="Costo registrato dei dispositivi" icon="€" tone="violet" /><StatCard label="Canoni mensili" value={money(finance?.monthly_fees)} caption="Canoni NOL registrati" icon="↻" tone="green" /><StatCard label="In noleggio" value={finance?.rental_devices ?? '—'} caption="Dispositivi con formula rental" icon="▤" tone="amber" /></div><div className="panel finance-note"><div className="finance-note-icon">€</div><div><h3>Dashboard Finance</h3><p>Questa sezione mostra solo gli indicatori di sintesi richiesti per la prima fase. I valori dipendono dai costi e dai canoni registrati nelle schede device e dallo storico acquisti.</p></div></div></section>}

          {page === 'warehouse' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">LOGISTICA</p><h2>Magazzino</h2><p className="muted">Ubicazioni e storico dei movimenti delle apparecchiature.</p></div><button className="primary-button" onClick={() => setModal('location')}>＋ Nuova ubicazione</button></div><div className="stats-grid two-stats"><StatCard label="Ubicazioni" value={locations.length} caption="Magazzini configurati" icon="▤" /><StatCard label="Device in stock" value={devices.filter((device) => device.status === 'in_stock').length} caption="Disponibili a magazzino" icon="▣" tone="green" /></div><div className="panel"><div className="panel-heading"><div><h3>Ubicazioni</h3><p>Magazzini disponibili</p></div></div>{locations.length ? <div className="location-grid">{locations.map((location) => <article className="location-card" key={location.id}><span className="location-icon">▤</span><div><strong>{location.name}</strong><p>{location.address || 'Indirizzo non impostato'}</p></div><span className="location-count">{location.device_count} device</span></article>)}</div> : <EmptyState icon="▤" title="Nessun magazzino configurato" description="Aggiungi un'ubicazione, ad esempio Molo STC o Magazzino Clerici." />}</div><div className="panel"><div className="panel-heading"><div><h3>Ultimi movimenti</h3><p>Gli ultimi 100 movimenti registrati</p></div><button className="secondary-button" onClick={() => setModal('movement')}>Registra movimento</button></div>{movements.length ? <div className="movement-list">{movements.map((movement) => <div className="movement-row" key={movement.id}><span className="activity-icon blue">↔</span><div><strong>{movement.manufacturer} {movement.model_name} {movement.asset_tag ? '· ' + movement.asset_tag : ''}</strong><small>{movement.from_location_name || '—'} → {movement.to_location_name || movement.branch_nomenclature || '—'}</small></div><time>{date(movement.moved_at)}</time></div>)}</div> : <EmptyState icon="↔" title="Nessun movimento registrato" description="I movimenti appariranno qui dopo la prima registrazione." />}</div></section>}

          {page === 'admin' && <section className="page-content"><div className="page-intro"><div><p className="eyebrow">CONFIGURAZIONE</p><h2>Amministrazione</h2><p className="muted">Gestisci le anagrafiche di riferimento e i valori precompilati.</p></div></div><div className="tabs admin-tabs"><button className={adminTab === 'companies' ? 'selected' : ''} onClick={() => setAdminTab('companies')}>Ragioni sociali</button><button className={adminTab === 'models' ? 'selected' : ''} onClick={() => setAdminTab('models')}>Catalogo device</button>{user.role === 'admin' && <button className={adminTab === 'profiles' ? 'selected' : ''} onClick={() => setAdminTab('profiles')}>Storico acquisti</button>}{user.role === 'admin' && <button className={adminTab === 'users' ? 'selected' : ''} onClick={() => setAdminTab('users')}>Utenti</button>}</div>{adminTab === 'companies' && <div className="panel"><div className="panel-heading"><div><h3>Ragioni sociali</h3><p>Società utilizzabili nelle anagrafiche filiale</p></div><button className="primary-button" onClick={() => { setCompanyForm({ legal_name: '', tax_code: '' }); setModal('company'); }}>＋ Nuova ragione sociale</button></div>{companies.length ? <div className="table-panel nested-table"><table><thead><tr><th>Ragione sociale</th><th>Codice fiscale / P.IVA</th><th>Filiali</th></tr></thead><tbody>{companies.map((company) => <tr key={company.id}><td><strong>{company.legal_name}</strong></td><td>{company.tax_code || '—'}</td><td>{company.branch_count ?? 0}</td></tr>)}</tbody></table></div> : <EmptyState icon="⌂" title="Nessuna ragione sociale" description="Aggiungi le società prima di creare le filiali." />}</div>}{adminTab === 'models' && <div className="panel"><div className="panel-heading"><div><h3>Catalogo device</h3><p>Modelli e valori di riferimento per precompilare i nuovi apparati</p></div><button className="primary-button" onClick={() => { setModelForm({ manufacturer: '', model_name: '', category: 'Collaboration', ownership_type: 'sale', default_purchase_cost: '', default_monthly_fee: '', useful_life_months: '', notes: '' }); setModal('model'); }}>＋ Nuovo modello</button></div>{models.length ? <div className="table-panel nested-table"><table><thead><tr><th>Produttore / modello</th><th>Categoria</th><th>Formula</th><th>Costo default</th><th>Canone mensile</th></tr></thead><tbody>{models.map((model) => <tr key={model.id}><td><strong>{model.manufacturer}</strong><small>{model.model_name}</small></td><td>{model.category}</td><td><span className="soft-tag">{model.ownership_type === 'rental' ? 'NOL' : 'Acquisto'}</span></td><td>{money(model.default_purchase_cost)}</td><td>{money(model.default_monthly_fee)}</td></tr>)}</tbody></table></div> : <EmptyState icon="▣" title="Catalogo vuoto" description="Aggiungi modelli come Cisco Room Bar per precompilare i dati dei device." />}</div>}{adminTab === 'profiles' && user.role === 'admin' && <div className="panel"><div className="panel-heading"><div><h3>Storico acquisti e canoni</h3><p>Profili inseriti manualmente, utilizzati per precompilare i nuovi device.</p></div><button className="primary-button" onClick={() => { setProfileForm({ device_model_id: '', supplier: '', reference: '', purchased_on: '', unit_cost: '', monthly_fee: '', useful_life_months: '', notes: '' }); setModal('purchaseProfile'); }}>＋ Nuovo riferimento</button></div>{purchaseProfiles.length ? <div className="table-panel nested-table"><table><thead><tr><th>Modello</th><th>Data acquisto</th><th>Fornitore / riferimento</th><th>Costo unitario</th><th>Canone mensile</th></tr></thead><tbody>{purchaseProfiles.map((profile) => <tr key={profile.id}><td><strong>{profile.manufacturer} {profile.model_name}</strong></td><td>{date(profile.purchased_on)}</td><td>{profile.supplier || '—'}<small>{profile.reference || ''}</small></td><td>{money(profile.unit_cost)}</td><td>{money(profile.monthly_fee)}</td></tr>)}</tbody></table></div> : <EmptyState icon="↻" title="Storico non configurato" description="Inserisci i valori di acquisto e canone che vuoi proporre durante la registrazione di un device." />}</div>}{adminTab === 'users' && user.role === 'admin' && <div className="panel"><div className="panel-heading"><div><h3>Utenti e ruoli</h3><p>Accessi individuali al workspace</p></div><button className="primary-button" onClick={() => { setUserForm({ username: '', display_name: '', password: '', role: 'technician' }); setModal('user'); }}>＋ Nuovo utente</button></div>{users.length ? <div className="table-panel nested-table"><table><thead><tr><th>Utente</th><th>Username</th><th>Ruolo</th><th>Stato</th></tr></thead><tbody>{users.map((item) => <tr key={item.id}><td><strong>{item.display_name}</strong></td><td>{item.username}</td><td><span className="soft-tag">{item.role}</span></td><td>{item.is_active ? 'Attivo' : 'Disattivato'}</td></tr>)}</tbody></table></div> : <EmptyState icon="♙" title="Nessun utente" description="Configura un utente amministratore tramite le variabili server per iniziare." />}</div>}</section>}
        </div>
      </main>

      {modal === 'branch' && <Modal title="Nuova filiale" subtitle="Inserisci l'anagrafica essenziale; gli altri campi possono essere completati dopo." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/branches', { method: 'POST', body: JSON.stringify(body) }), { ...branchForm, company_id: Number(branchForm.company_id) }); }}><BranchFields form={branchForm} setForm={setBranchForm} companies={companies} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy || !companies.length}>{busy ? 'Salvataggio…' : 'Salva filiale'}</button></div>{!companies.length && <p className="field-hint">Crea prima una ragione sociale in Amministrazione.</p>}</form></Modal>}

      {modal === 'editBranch' && <Modal title="Modifica filiale" subtitle="Aggiorna i dati anagrafici." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/branches/' + selectedBranch.id, { method: 'PUT', body: JSON.stringify(body) }), { ...branchForm, company_id: Number(branchForm.company_id) }).then(() => api('/branches/' + selectedBranch.id).then((result) => setSelectedBranch(result.data))); }}><BranchFields form={branchForm} setForm={setBranchForm} companies={companies} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Salva modifiche</button></div></form></Modal>}

      {modal === 'company' && <Modal title="Nuova ragione sociale" subtitle="La società sarà selezionabile nelle schede filiale." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/companies', { method: 'POST', body: JSON.stringify(body) }), companyForm); }}><label>Ragione sociale<input value={companyForm.legal_name} onChange={(event) => setCompanyForm({ ...companyForm, legal_name: event.target.value })} required maxLength="200" /></label><label>Codice fiscale / P.IVA<input value={companyForm.tax_code} onChange={(event) => setCompanyForm({ ...companyForm, tax_code: event.target.value })} maxLength="50" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Salva ragione sociale</button></div></form></Modal>}

      {modal === 'model' && <Modal title="Nuovo modello device" subtitle="I valori standard saranno proposti quando registri un nuovo apparato." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const body = { ...modelForm, default_purchase_cost: modelForm.default_purchase_cost === '' ? null : Number(modelForm.default_purchase_cost), default_monthly_fee: modelForm.default_monthly_fee === '' ? null : Number(modelForm.default_monthly_fee), useful_life_months: modelForm.useful_life_months === '' ? null : Number(modelForm.useful_life_months) }; submitForm((payload) => api('/device-models', { method: 'POST', body: JSON.stringify(payload) }), body); }}><div className="form-grid"><label>Produttore<input value={modelForm.manufacturer} onChange={(event) => setModelForm({ ...modelForm, manufacturer: event.target.value })} required /></label><label>Modello<input value={modelForm.model_name} onChange={(event) => setModelForm({ ...modelForm, model_name: event.target.value })} required /></label><label>Categoria<input value={modelForm.category} onChange={(event) => setModelForm({ ...modelForm, category: event.target.value })} required /></label><label>Formula economica<select value={modelForm.ownership_type} onChange={(event) => setModelForm({ ...modelForm, ownership_type: event.target.value })}><option value="sale">Acquisto</option><option value="rental">NOL / noleggio</option></select></label><label>Costo di acquisto (€)<input type="number" min="0" step="0.01" value={modelForm.default_purchase_cost} onChange={(event) => setModelForm({ ...modelForm, default_purchase_cost: event.target.value })} /></label><label>Canone mensile (€)<input type="number" min="0" step="0.01" value={modelForm.default_monthly_fee} onChange={(event) => setModelForm({ ...modelForm, default_monthly_fee: event.target.value })} /></label><label>Vita utile (mesi)<input type="number" min="1" step="1" value={modelForm.useful_life_months} onChange={(event) => setModelForm({ ...modelForm, useful_life_months: event.target.value })} /></label></div><label>Note<textarea rows="3" value={modelForm.notes} onChange={(event) => setModelForm({ ...modelForm, notes: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Salva modello</button></div></form></Modal>}

      {(modal === 'device' || modal.startsWith('editDevice:')) && <Modal title={modal.startsWith('editDevice:') ? 'Modifica device' : 'Registra device'} subtitle="Seleziona il modello per caricare i valori predefiniti." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const model = models.find((item) => String(item.id) === String(deviceForm.model_id)); const body = { ...deviceForm, model_id: Number(deviceForm.model_id), purchase_profile_id: deviceForm.purchase_profile_id ? Number(deviceForm.purchase_profile_id) : null, branch_id: deviceForm.branch_id ? Number(deviceForm.branch_id) : null, ownership_type: deviceForm.ownership_type || model?.ownership_type || 'sale', purchase_cost: deviceForm.purchase_cost === '' ? (model?.default_purchase_cost ?? null) : Number(deviceForm.purchase_cost), monthly_fee: deviceForm.monthly_fee === '' ? (model?.default_monthly_fee ?? null) : Number(deviceForm.monthly_fee) }; const editId = modal.startsWith('editDevice:') ? modal.split(':')[1] : null; submitForm((payload) => api(editId ? '/devices/' + editId : '/devices', { method: editId ? 'PUT' : 'POST', body: JSON.stringify(payload) }), body); }}><label>Modello<select value={deviceForm.model_id} onChange={(event) => { const model = models.find((item) => String(item.id) === event.target.value); const profile = purchaseProfiles.find((item) => String(item.device_model_id) === event.target.value); setDeviceForm({ ...deviceForm, model_id: event.target.value, purchase_profile_id: profile ? String(profile.id) : '', ownership_type: model?.ownership_type || 'sale', purchase_cost: profile?.unit_cost ?? model?.default_purchase_cost ?? '', monthly_fee: profile?.monthly_fee ?? model?.default_monthly_fee ?? '' }); }} required><option value="">Seleziona modello</option>{models.map((model) => <option key={model.id} value={model.id}>{model.manufacturer} {model.model_name}</option>)}</select></label><label>Riferimento storico<select value={deviceForm.purchase_profile_id} onChange={(event) => { const profile = purchaseProfiles.find((item) => String(item.id) === event.target.value); setDeviceForm({ ...deviceForm, purchase_profile_id: event.target.value, purchase_cost: profile?.unit_cost ?? deviceForm.purchase_cost, monthly_fee: profile?.monthly_fee ?? deviceForm.monthly_fee }); }}><option value="">Valori standard del modello</option>{purchaseProfiles.filter((profile) => String(profile.device_model_id) === String(deviceForm.model_id)).map((profile) => <option key={profile.id} value={profile.id}>{profile.supplier || 'Storico'} · {date(profile.purchased_on)} · {money(profile.unit_cost)}</option>)}</select></label><div className="form-grid"><label>Filiale<select value={deviceForm.branch_id} onChange={(event) => setDeviceForm({ ...deviceForm, branch_id: event.target.value, status: event.target.value ? 'operational' : 'in_stock' })}><option value="">A magazzino / non assegnato</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.nomenclature || branch.street} · {branch.company_name}</option>)}</select></label><label>Stato<select value={deviceForm.status} onChange={(event) => setDeviceForm({ ...deviceForm, status: event.target.value })}><option value="in_stock">A magazzino</option><option value="to_activate">Da attivare</option><option value="operational">Operativo</option><option value="fault">Guasto</option><option value="decommissioned">Dismesso</option></select></label><label>Asset tag<input value={deviceForm.asset_tag} onChange={(event) => setDeviceForm({ ...deviceForm, asset_tag: event.target.value })} /></label><label>Matricola<input value={deviceForm.serial_number} onChange={(event) => setDeviceForm({ ...deviceForm, serial_number: event.target.value })} /></label><label>Costo acquisto (€)<input type="number" min="0" step="0.01" value={deviceForm.purchase_cost} onChange={(event) => setDeviceForm({ ...deviceForm, purchase_cost: event.target.value })} /></label><label>Canone mensile (€)<input type="number" min="0" step="0.01" value={deviceForm.monthly_fee} onChange={(event) => setDeviceForm({ ...deviceForm, monthly_fee: event.target.value })} /></label></div><label>Note<textarea rows="3" value={deviceForm.notes} onChange={(event) => setDeviceForm({ ...deviceForm, notes: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy || !models.length}>{busy ? 'Salvataggio…' : 'Salva device'}</button></div>{!models.length && <p className="field-hint">Aggiungi prima un modello nel Catalogo device.</p>}</form></Modal>}

      {modal === 'purchaseProfile' && <Modal title="Nuovo riferimento storico" subtitle="Inserisci manualmente i valori storici di acquisto o noleggio per un modello." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const body = { ...profileForm, device_model_id: Number(profileForm.device_model_id), unit_cost: profileForm.unit_cost === '' ? null : Number(profileForm.unit_cost), monthly_fee: profileForm.monthly_fee === '' ? null : Number(profileForm.monthly_fee), useful_life_months: profileForm.useful_life_months === '' ? null : Number(profileForm.useful_life_months) }; submitForm((payload) => api('/purchase-profiles', { method: 'POST', body: JSON.stringify(payload) }), body); }}><label>Modello<select value={profileForm.device_model_id} onChange={(event) => setProfileForm({ ...profileForm, device_model_id: event.target.value })} required><option value="">Seleziona modello</option>{models.map((model) => <option key={model.id} value={model.id}>{model.manufacturer} {model.model_name}</option>)}</select></label><div className="form-grid"><label>Fornitore<input value={profileForm.supplier} onChange={(event) => setProfileForm({ ...profileForm, supplier: event.target.value })} /></label><label>Riferimento ordine / lotto<input value={profileForm.reference} onChange={(event) => setProfileForm({ ...profileForm, reference: event.target.value })} /></label><label>Data acquisto<input type="date" value={profileForm.purchased_on} onChange={(event) => setProfileForm({ ...profileForm, purchased_on: event.target.value })} /></label><label>Costo unitario (€)<input type="number" min="0" step="0.01" value={profileForm.unit_cost} onChange={(event) => setProfileForm({ ...profileForm, unit_cost: event.target.value })} /></label><label>Canone mensile (€)<input type="number" min="0" step="0.01" value={profileForm.monthly_fee} onChange={(event) => setProfileForm({ ...profileForm, monthly_fee: event.target.value })} /></label><label>Vita utile (mesi)<input type="number" min="1" step="1" value={profileForm.useful_life_months} onChange={(event) => setProfileForm({ ...profileForm, useful_life_months: event.target.value })} /></label></div><label>Note<textarea rows="3" value={profileForm.notes} onChange={(event) => setProfileForm({ ...profileForm, notes: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy || !models.length}>Salva riferimento</button></div></form></Modal>}{modal === 'user' && <Modal title="Nuovo utente" subtitle="La password iniziale deve contenere almeno 12 caratteri." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/admin/users', { method: 'POST', body: JSON.stringify(body) }), userForm); }}><label>Nome visualizzato<input value={userForm.display_name} onChange={(event) => setUserForm({ ...userForm, display_name: event.target.value })} required /></label><label>Username<input value={userForm.username} onChange={(event) => setUserForm({ ...userForm, username: event.target.value })} required /></label><label>Password iniziale<input type="password" autoComplete="new-password" minLength="12" value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} required /></label><label>Ruolo<select value={userForm.role} onChange={(event) => setUserForm({ ...userForm, role: event.target.value })}><option value="technician">Tecnico</option><option value="sales">Commerciale</option><option value="warehouse">Magazzino</option><option value="finance">Finance</option><option value="admin">Amministratore</option></select></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Crea utente</button></div></form></Modal>}

      {modal === 'checklist' && <Modal title="Nuova checklist" subtitle="Inserisci una voce per riga." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/branches/' + selectedBranch.id + '/checklists', { method: 'POST', body: JSON.stringify(body) }), { title: checklistForm.title, items: checklistForm.items.split('\n').map((item) => item.trim()).filter(Boolean) }).then(() => api('/branches/' + selectedBranch.id + '/checklists').then((result) => setChecklists(result.data))); }}><label>Titolo<input value={checklistForm.title} onChange={(event) => setChecklistForm({ ...checklistForm, title: event.target.value })} required /></label><label>Voci checklist<textarea rows="6" value={checklistForm.items} onChange={(event) => setChecklistForm({ ...checklistForm, items: event.target.value })} required /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Crea checklist</button></div></form></Modal>}

      {modal === 'location' && <Modal title="Nuova ubicazione" onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/stock/locations', { method: 'POST', body: JSON.stringify(body) }), locationForm); }}><label>Nome magazzino<input value={locationForm.name} onChange={(event) => setLocationForm({ ...locationForm, name: event.target.value })} required /></label><label>Indirizzo<input value={locationForm.address} onChange={(event) => setLocationForm({ ...locationForm, address: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Salva ubicazione</button></div></form></Modal>}

      {modal === 'movement' && <Modal title="Registra movimento" subtitle="Il movimento aggiorna anche assegnazione e stato del device." onClose={() => setModal('')}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); submitForm((body) => api('/stock/movements', { method: 'POST', body: JSON.stringify(body) }), { ...movementForm, device_id: Number(movementForm.device_id), from_location_id: movementForm.from_location_id ? Number(movementForm.from_location_id) : null, to_location_id: movementForm.to_location_id ? Number(movementForm.to_location_id) : null, branch_id: movementForm.branch_id ? Number(movementForm.branch_id) : null }); }}><label>Dispositivo<select value={movementForm.device_id} onChange={(event) => setMovementForm({ ...movementForm, device_id: event.target.value })} required><option value="">Seleziona device</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.manufacturer} {device.model_name} · {device.asset_tag || 'senza tag'}</option>)}</select></label><label>Tipo movimento<input value={movementForm.movement_type} onChange={(event) => setMovementForm({ ...movementForm, movement_type: event.target.value })} required /></label><div className="form-grid"><label>Da ubicazione<select value={movementForm.from_location_id} onChange={(event) => setMovementForm({ ...movementForm, from_location_id: event.target.value })}><option value="">—</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>A ubicazione<select value={movementForm.to_location_id} onChange={(event) => setMovementForm({ ...movementForm, to_location_id: event.target.value })}><option value="">—</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>Filiale di destinazione<select value={movementForm.branch_id} onChange={(event) => setMovementForm({ ...movementForm, branch_id: event.target.value })}><option value="">Nessuna</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.nomenclature || branch.street}</option>)}</select></label></div><label>Note<textarea rows="2" value={movementForm.notes} onChange={(event) => setMovementForm({ ...movementForm, notes: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal('')}>Annulla</button><button className="primary-button" disabled={busy}>Registra movimento</button></div></form></Modal>}
    </div>
  );
}

function BranchFields({ form, setForm, companies }) {
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  return <>
    <label>Ragione sociale<select value={form.company_id} onChange={(event) => update('company_id', event.target.value)} required><option value="">Seleziona società</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.legal_name}</option>)}</select></label>
    <div className="form-grid"><label>Paese<input value={form.country} onChange={(event) => update('country', event.target.value)} required /></label><label>Via<input value={form.street} onChange={(event) => update('street', event.target.value)} required /></label><label>Nomenclatura<input value={form.nomenclature} onChange={(event) => update('nomenclature', event.target.value)} /></label><label>Vecchia nomenclatura<input value={form.previous_nomenclature} onChange={(event) => update('previous_nomenclature', event.target.value)} /></label><label>Network<input value={form.network} onChange={(event) => update('network', event.target.value)} placeholder="Es. LAN / MPLS" /></label><label>Phone Prefix<input value={form.phone_prefix} onChange={(event) => update('phone_prefix', event.target.value)} /></label><label className="span-two">WLC<input value={form.wlc} onChange={(event) => update('wlc', event.target.value)} /></label></div>
  </>;
}

function DeviceTable({ devices, onEdit }) {
  if (!devices.length) return null;
  const labels = { in_stock: 'A magazzino', to_activate: 'Da attivare', operational: 'Operativo', fault: 'Guasto', decommissioned: 'Dismesso' };
  return <div className="table-panel nested-table"><table><thead><tr><th>Dispositivo</th><th>Asset tag / matricola</th><th>Filiale / ubicazione</th><th>Stato</th><th>Canone</th><th /></tr></thead><tbody>{devices.map((device) => <tr key={device.id}><td><strong>{device.manufacturer} {device.model_name}</strong><small>{device.category}</small></td><td>{device.asset_tag || '—'}<small>{device.serial_number || 'Matricola non inserita'}</small></td><td>{device.branch_nomenclature || device.stock_location || 'Non assegnato'}<small>{device.company_name || ''}</small></td><td><span className={'status-pill status-' + device.status}>{labels[device.status] || device.status}</span></td><td>{money(device.monthly_fee)}</td><td>{onEdit && <button className="row-action" onClick={() => onEdit(device)}>Modifica</button>}</td></tr>)}</tbody></table></div>;
}
