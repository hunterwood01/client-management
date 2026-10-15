import { useEffect, useState } from 'react';

const api = async (path, options = {}) => {
  const response = await fetch('/api' + path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Operazione non riuscita.');
  return payload;
};
const money = value => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));

export default function DeviceFaultManagement({ device, devices, locations, productStock = [], onClose, onSaved }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ fault_date: new Date().toISOString().slice(0,10), description: '', outcome: 'pending', rma_number: '', rma_status: 'da_aprire', replacement_device_id: '', replacement_stock_model_id: '', replacement_stock_location_id: '', additional_cost: '0', cost_description: '', notes: '' });

  async function load() {
    setLoading(true); setError('');
    try { const result = await api('/devices/' + device.id + '/fault-events'); setEvents(result.data || []); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [device.id]);
  function startNew() {
    setEditing(null);
    setForm({ fault_date: new Date().toISOString().slice(0,10), description: '', outcome: 'pending', rma_number: '', rma_status: 'da_aprire', replacement_device_id: '', replacement_stock_model_id: '', replacement_stock_location_id: device.stock_location_id ? String(device.stock_location_id) : '', additional_cost: '0', cost_description: '', notes: '' });
  }
  function editEvent(event) {
    setEditing(event.id);
    setForm({ fault_date: String(event.fault_date || '').slice(0,10), description: event.description || '', outcome: event.outcome || 'pending', rma_number: event.rma_number || '', rma_status: event.rma_status || 'da_aprire', replacement_device_id: event.replacement_device_id ? String(event.replacement_device_id) : '', replacement_stock_model_id: event.replacement_stock_model_id ? String(event.replacement_stock_model_id) : '', replacement_stock_location_id: event.replacement_stock_location_id ? String(event.replacement_stock_location_id) : '', additional_cost: String(event.additional_cost || 0), cost_description: event.cost_description || '', notes: event.notes || '' });
  }
  async function save(event) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const payload = { ...form, replacement_device_id: form.replacement_device_id ? Number(form.replacement_device_id) : null, replacement_stock_model_id: form.replacement_stock_model_id ? Number(form.replacement_stock_model_id) : null, replacement_stock_location_id: form.replacement_stock_location_id ? Number(form.replacement_stock_location_id) : null, additional_cost: Number(form.additional_cost || 0) };
      await api(editing ? '/device-fault-events/' + editing : '/devices/' + device.id + '/fault-events', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      await load(); await onSaved(); startNew();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  const available = devices.filter(item => String(item.id) !== String(device.id) && item.status === 'in_stock' && (!form.replacement_stock_location_id || String(item.stock_location_id) === String(form.replacement_stock_location_id)) && String(item.model_id) === String(device.model_id));
  const availableStock = productStock.filter(item => Number(item.available_quantity || 0) > 0 && (!form.replacement_stock_location_id || String(item.stock_location_id) === String(form.replacement_stock_location_id)) && String(item.device_model_id) === String(device.model_id));
  const outcomeLabel = { pending: 'In valutazione', rma: 'RMA', sci: 'SCI · irrecuperabile', resolved: 'Risolto' };
  const rmaLabel = { da_aprire: 'Da aprire', aperta: 'Aperta', spedito: 'Spedito al fornitore', in_riparazione: 'In riparazione', sostituito: 'Sostituito', chiusa: 'Chiusa' };
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal fault-management-modal" role="dialog" aria-modal="true" aria-labelledby="fault-management-title">
      <div className="modal-header"><div><h2 id="fault-management-title">Gestione guasto</h2><p>{device.manufacturer} {device.model_name} · Seriale {device.serial_number || 'non disponibile'} · {device.branch_nomenclature || device.company_name || 'Filiale non assegnata'}</p></div><div className="fault-header-actions"><button type="button" className="secondary-button" onClick={onClose}>← Torna ai dispositivi</button><button type="button" className="icon-button" onClick={onClose} aria-label="Chiudi">×</button></div></div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="fault-management-layout">
        <section className="panel"><div className="panel-heading"><div><h3>{editing ? 'Modifica evento' : 'Nuova segnalazione'}</h3><p>Lo storico del dispositivo originale viene mantenuto.</p></div></div>
          <form className="form-stack" onSubmit={save}>
            <div className="form-grid"><label>Data guasto<input type="date" value={form.fault_date} onChange={e => setForm({...form, fault_date:e.target.value})} required /></label><label>Esito<select value={form.outcome} onChange={e => setForm({...form, outcome:e.target.value})}><option value="pending">In valutazione</option><option value="rma">RMA</option><option value="sci">SCI · irrecuperabile</option><option value="resolved">Risolto</option></select></label></div>
            <label>Descrizione del problema<textarea rows="2" value={form.description} onChange={e => setForm({...form, description:e.target.value})} required /></label>
            {form.outcome === 'rma' && <div className="form-grid"><label>Numero RMA<input value={form.rma_number} onChange={e => setForm({...form, rma_number:e.target.value})} placeholder="Numero pratica" /></label><label>Stato RMA<select value={form.rma_status} onChange={e => setForm({...form, rma_status:e.target.value})}>{Object.entries(rmaLabel).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>}
            <label>Magazzino del sostitutivo<select value={form.replacement_stock_location_id} onChange={e => setForm({...form, replacement_stock_location_id:e.target.value, replacement_device_id:''})}><option value="">Qualsiasi magazzino</option>{locations.map(location => <option key={location.id} value={String(location.id)}>{location.name}</option>)}</select></label>
            <label>Device sostitutivo già censito<select value={form.replacement_device_id} onChange={e => setForm({...form, replacement_device_id:e.target.value, replacement_stock_model_id:''})}><option value="">Nessun device già censito</option>{available.map(item => <option key={item.id} value={String(item.id)}>{item.sku || item.model_name} · {item.serial_number || ('Device #' + item.id)} · {item.stock_location || 'Magazzino non indicato'}</option>)}</select></label><label>Prelievo da giacenza di magazzino<select value={form.replacement_stock_model_id} onChange={e => setForm({...form, replacement_stock_model_id:e.target.value, replacement_device_id:'', replacement_stock_location_id:e.target.value ? form.replacement_stock_location_id : form.replacement_stock_location_id})}><option value="">Nessun prelievo da giacenza</option>{availableStock.map(item => <option key={item.device_model_id + '-' + item.stock_location_id} value={String(item.device_model_id)}>{item.sku || item.model_name} · {item.stock_location_name} · disponibili: {item.available_quantity} · costo unitario medio: {money(item.average_unit_cost)}</option>)}</select><small className="field-hint">Mostra la giacenza reale per modello e magazzino. Il costo del materiale verrà registrato sul guasto NOL al prelievo.</small></label>
            <div className="form-grid"><label>Costi aggiuntivi (€)<input type="number" min="0" step="0.01" value={form.additional_cost} onChange={e => setForm({...form, additional_cost:e.target.value})} required /></label><label>Descrizione costo<input value={form.cost_description} onChange={e => setForm({...form, cost_description:e.target.value})} placeholder="Trasporto, riparazione…" /></label></div>
            <label>Note<textarea rows="2" value={form.notes} onChange={e => setForm({...form, notes:e.target.value})} /></label>
            {form.outcome === 'sci' && <p className="field-hint">Con l'esito SCI il dispositivo originale sarà marcato come dismesso. Il costo storico non viene cancellato.</p>}
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={startNew}>Nuovo evento</button><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Salvataggio…' : editing ? 'Salva modifiche' : 'Registra guasto'}</button></div>
          </form>
        </section>
        <section className="panel"><div className="panel-heading"><div><h3>Storico guasti</h3><p>{events.length} eventi registrati</p></div></div>
          {loading ? <p className="muted">Caricamento storico…</p> : events.length ? <div className="fault-event-list">{events.map(item => <article className="fault-event" key={item.id}><div className="fault-event-heading"><strong>{new Date(item.fault_date + 'T12:00:00').toLocaleDateString('it-IT')} · {outcomeLabel[item.outcome] || item.outcome}</strong><span className={'status-pill ' + (item.status === 'closed' ? 'status-operational' : 'status-fault')}>{item.status === 'closed' ? 'Chiuso' : 'Aperto'}</span></div><p>{item.description}</p>{item.rma_number && <small>RMA {item.rma_number} · {rmaLabel[item.rma_status] || item.rma_status}</small>}{item.replacement_serial && <small>Sostitutivo: {item.replacement_model} · {item.replacement_serial} (da attivare)</small>}<div className="fault-event-footer"><span>Costi aggiuntivi: {money(item.additional_cost)}</span><button type="button" className="row-action" onClick={() => editEvent(item)}>Modifica</button></div>{item.notes && <small>{item.notes}</small>}</article>)}</div> : <p className="muted">Nessun guasto registrato per questo dispositivo.</p>}
        </section>
      </div>
    </section>
  </div>;
}
