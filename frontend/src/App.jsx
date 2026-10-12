export default function App() {
  return (
    <main className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">CM</span>
          <span>Client Management</span>
        </div>
        <span className="status">Ambiente iniziale</span>
      </header>

      <section className="welcome">
        <p className="eyebrow">CLIENT MANAGEMENT PLATFORM</p>
        <h1>Gestione clienti</h1>
        <p className="description">
          La piattaforma è in fase di configurazione.
          Qui troverai le funzionalità di gestione clienti,
          collegate al backend e al database.
        </p>
        <div className="info-card">
          <span className="indicator" />
          <div>
            <strong>Frontend React</strong>
            <p>Struttura iniziale pronta per l'integrazione API.</p>
          </div>
        </div>
      </section>

      <footer>Client Management · Versione iniziale</footer>
    </main>
  );
}
