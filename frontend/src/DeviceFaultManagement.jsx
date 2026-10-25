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
  const [selectedReplacementModel, setSelectedReplacementModel] = useState('');
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
    setSelectedReplacementModel('');
    setForm({ fault_date: new Date().toISOString().slice(0,10), description: '', outcome: 'pending', rma_number: '', rma_status: 'da_aprire', replacement_device_id: '', replacement_stock_model_id: '', replacement_stock_location_id: device.stock_location_id ? String(device.stock_location_id) : '', additional_cost: '0', cost_description: '', notes: '' });
  }
  function editEvent(event) {
    setEditing(event.id);
    setSelectedReplacementModel(String(devices.find(item => String(item.id) === String(event.replacement_device_id))?.model_id || ''));
    setForm({ fault_date: String(event.fault_date || '').slice(0,10), description: event.description || '', outcome: event.outcome || 'pending', rma_number: event.rma_number || '', rma_status: event.rma_status || 'da_aprire', replacement_device_id: event.replacement_device_id ? String(event.replacement_device_id) : '', replacement_stock_model_id: event.replacement_stock_model_id ? String(event.replacement_stock_model_id) : '', replacement_stock_location_id: event.replacement_stock_location_id ? String(event.replacement_stock_location_id) : '', additional_cost: String(event.additional_cost || 0), cost_description: event.cost_description || '', notes: event.notes || '' });
  }
  async function save(event) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const isStockPick = form.replacement_device_id === 'stock';
      const payload = { ...form, replacement_device_id: form.replacement_device_id && !isStockPick ? Number(form.replacement_device_id) : null, replacement_stock_model_id: isStockPick && selectedReplacementModel ? Number(selectedReplacementModel) : null, replacement_stock_location_id: form.replacement_stock_location_id ? Number(form.replacement_stock_location_id) : null, additional_cost: Number(form.additional_cost || 0) };
      await api(editing ? '/device-fault-events/' + editing : '/devices/' + device.id + '/fault-events', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      await load(); await onSaved(); startNew();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  async function deleteEvent(event) {
    const summary = new Date(String(event.fault_date || '').slice(0,10) + 'T12:00:00').toLocaleDateString('it-IT');
    if (!window.confirm('Eliminare lo storico del guasto del ' + summary + '? I dispositivi e le giacenze di magazzino resteranno invariati.')) return;
    setError('');
    try {
      await api('/device-fault-events/' + event.id, { method: 'DELETE' });
      if (String(editing) === String(event.id)) startNew();
      await load();
      await onSaved();
    } catch (err) {
      setError(err.message);
    }
  }
  const availableAtWarehouse = devices.filter(item =>
    String(item.id) !== String(device.id) &&
    ['in_stock', 'to_activate'].includes(item.status) &&
    !item.branch_id &&
    item.stock_consumed !== true &&
    Boolean(form.replacement_stock_location_id) &&
    String(item.stock_location_id || '') === String(form.replacement_stock_location_id)
  );
  const isRentalDevice = device.ownership_type === 'rental';
  const stockModelsAtLocation = productStock.filter(item =>
    String(item.stock_location_id) === String(form.replacement_stock_location_id) &&
    Number(item.available_quantity ?? item.quantity ?? 0) > 0
  );
  const replacementModels = [...new Map([
    ...availableAtWarehouse.map(item => ({
      id: String(item.model_id ?? item.device_model_id),
      label: [item.manufacturer, item.model_name].filter(Boolean).join(' ') || item.sku || ('Modello #' + (item.model_id ?? item.device_model_id))
    })),
    ...(isRentalDevice ? stockModelsAtLocation
      .filter(item => String(item.device_model_id) === String(device.model_id))
      .map(item => ({ id: String(item.device_model_id), label: [item.manufacturer, item.model_name].filter(Boolean).join(' ') || item.sku || ('Modello #' + item.device_model_id) })) : [])
  ].map(item => [item.id, item])).values()].filter(item => item.id && item.id !== 'undefined');
  const selectedStock = stockModelsAtLocation.find(item => String(item.device_model_id) === String(selectedReplacementModel));
  const stockAvailable = isRentalDevice && Boolean(selectedStock) && Number(selectedStock.available_quantity ?? selectedStock.quantity ?? 0) > 0;
  const available = availableAtWarehouse.filter(item =>
    selectedReplacementModel && String(item.model_id ?? item.device_model_id) === String(selectedReplacementModel)
  );
  const outcomeLabel = { pending: 'In valutazione', rma: 'RMA', sci: 'SCI · irrecuperabile', resolved: 'Risolto' };
  const rmaLabel = { da_aprire: 'Da aprire', aperta: 'Aperta', spedito: 'Spedito al fornitore', in_riparazione: 'In riparazione', sostituito: 'Sostituito', chiusa: 'Chiusa' };
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal fault-management-modal" role="dialog" aria-modal="true" aria-labelledby="fault-management-title">
      <div className="modal-header"><div><h2 id="fault-management-title">Gestione guasto</h2><p>{device.manufacturer} {device.model_name} · Seriale {device.serial_number || 'non disponibile'} · {device.branch_nomenclature || device.company_name || 'Filiale non assegnata'}</p></div><div className="fault-header-actions"><button type="button" className="secondary-button" onClick={onClose}>← Indietro</button><button type="button" className="icon-button" onClick={onClose} aria-label="Chiudi">×</button></div></div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="fault-management-layout">
        <section className="panel"><div className="panel-heading"><div><h3>{editing ? 'Modifica evento' : 'Nuova segnalazione'}</h3><p>Lo storico del dispositivo originale viene mantenuto.</p></div></div>
          <form className="form-stack" onSubmit={save}>
            <div className="form-grid"><label>Data guasto<input type="date" value={form.fault_date} onChange={e => setForm({...form, fault_date:e.target.value})} required /></label><label>Esito<select value={form.outcome} onChange={e => setForm({...form, outcome:e.target.value})}><option value="pending">In valutazione</option><option value="rma">RMA</option><option value="sci">SCI · irrecuperabile</option><option value="resolved">Risolto</option></select></label></div>
            <label>Descrizione del problema<textarea rows="2" value={form.description} onChange={e => setForm({...form, description:e.target.value})} required /></label>
            {form.outcome === 'rma' && <div className="form-grid"><label>Numero RMA<input value={form.rma_number} onChange={e => setForm({...form, rma_number:e.target.value})} placeholder="Numero pratica" /></label><label>Stato RMA<select value={form.rma_status} onChange={e => setForm({...form, rma_status:e.target.value})}>{Object.entries(rmaLabel).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>}
            <label>1. Magazzino del sostitutivo<select value={form.replacement_stock_location_id} onChange={e => { setSelectedReplacementModel(''); setForm({...form, replacement_stock_location_id:e.target.value, replacement_device_id:'', replacement_stock_model_id:''}); }} required><option value="">Seleziona un magazzino</option>{locations.map(location => <option key={location.id} value={String(location.id)}>{location.name}</option>)}</select></label>
            <label>2. Modello del sostitutivo<select value={selectedReplacementModel} onChange={e => { const modelId = e.target.value; const stockItem = productStock.find(item => String(item.stock_location_id) === String(form.replacement_stock_location_id) && String(item.device_model_id) === String(modelId) && Number(item.available_quantity ?? item.quantity ?? 0) > 0); setSelectedReplacementModel(modelId); setForm({...form, replacement_device_id:'', replacement_stock_model_id:'', additional_cost: stockItem ? String(Number(stockItem.average_unit_cost || 0).toFixed(2)) : form.additional_cost, cost_description: stockItem ? (form.cost_description || 'Costo hardware sostitutivo') : form.cost_description}); }} disabled={!form.replacement_stock_location_id}><option value="">Seleziona prima il magazzino</option>{replacementModels.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select><small className="field-hint">{!form.replacement_stock_location_id ? 'Scegli il magazzino per vedere i modelli disponibili.' : replacementModels.length ? 'Sono mostrati solo i modelli con device fisici disponibili in questo magazzino.' : 'Nessun device disponibile nel magazzino selezionato.'}</small></label>
            <label>3. Device sostitutivo<select value={form.replacement_device_id} onChange={e => { const value = e.target.value; const selectedDevice = availableAtWarehouse.find(item => String(item.id) === String(value)); const stockItem = productStock.find(item => String(item.stock_location_id) === String(form.replacement_stock_location_id) && String(item.device_model_id) === String(selectedReplacementModel)); const autoCost = value === 'stock' ? Number(stockItem?.average_unit_cost || 0) : selectedDevice ? Number(selectedDevice.purchase_cost || 0) : null; setForm({...form, replacement_device_id:value, replacement_stock_model_id:'', ...(autoCost !== null ? { additional_cost: String(autoCost.toFixed(2)), cost_description: form.cost_description || 'Costo hardware sostitutivo' } : {})}); }} disabled={!selectedReplacementModel}><option value="">{!selectedReplacementModel ? 'Seleziona prima il modello' : available.length || stockAvailable ? 'Seleziona il device o il prelievo da magazzino' : 'Nessun device disponibile per questo modello'}</option>{available.map(item => <option key={item.id} value={String(item.id)}>{item.sku || item.model_name || 'Device'} · {item.serial_number ? 'Seriale ' + item.serial_number : 'Device #' + item.id} · costo: {money(item.purchase_cost)}</option>)}{stockAvailable && <option value="stock">Preleva 1 unità dalla giacenza ({Number(selectedStock.available_quantity ?? selectedStock.quantity)} disponibili)</option>}</select><small className="field-hint">Seleziona un device già censito oppure, per i device NOL, preleva un'unità direttamente dalla giacenza del magazzino.</small></label>
            <div className="form-grid"><label>Costi aggiuntivi (€)<input type="number" min="0" step="0.01" value={form.additional_cost} onChange={e => setForm({...form, additional_cost:e.target.value})} required /></label><label>Descrizione costo<input value={form.cost_description} onChange={e => setForm({...form, cost_description:e.target.value})} placeholder="Trasporto, riparazione…" /></label></div>
            <label>Note<textarea rows="2" value={form.notes} onChange={e => setForm({...form, notes:e.target.value})} /></label>
            {form.outcome === 'sci' && <p className="field-hint">Con l'esito SCI il dispositivo originale sarà marcato come dismesso. Il costo storico non viene cancellato.</p>}
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={startNew}>Nuovo evento</button><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Salvataggio…' : editing ? 'Salva modifiche' : 'Registra guasto'}</button></div>
          </form>
        </section>
        <section className="panel"><div className="panel-heading"><div><h3>Storico guasti</h3><p>{events.length} eventi registrati</p></div></div>
          {loading ? <p className="muted">Caricamento storico…</p> : events.length ? <div className="fault-event-list">{events.map(item => <article className="fault-event" key={item.id}><div className="fault-event-heading"><strong>{new Date(item.fault_date + 'T12:00:00').toLocaleDateString('it-IT')} · {outcomeLabel[item.outcome] || item.outcome}</strong><span className={'status-pill ' + (item.status === 'closed' ? 'status-operational' : 'status-fault')}>{item.status === 'closed' ? 'Chiuso' : 'Aperto'}</span></div><p>{item.description}</p>{item.rma_number && <small>RMA {item.rma_number} · {rmaLabel[item.rma_status] || item.rma_status}</small>}{item.replacement_serial && <small>Sostitutivo: {item.replacement_model} · {item.replacement_serial} (da attivare)</small>}<div className="fault-event-footer"><span>Hardware sostitutivo: {money(item.replacement_hardware_cost)} · Costi aggiuntivi: {money(item.additional_cost)}</span><button type="button" className="row-action" onClick={() => editEvent(item)}>Modifica</button><button type="button" className="row-action" onClick={() => deleteEvent(item)}>Elimina</button></div>{item.notes && <small>{item.notes}</small>}</article>)}</div> : <p className="muted">Nessun guasto registrato per questo dispositivo.</p>}
        </section>
      </div>
    </section>
  </div>;
}
