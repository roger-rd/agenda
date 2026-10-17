import { pluralize } from '../../lib/pluralize';
import { CompanyCard } from './CompanyCard';
import { useState } from 'react';
import { Search, Plus } from 'lucide-react';
import { actions, useStore } from '../../store';
import { can } from '../../store/permissions';
import { selectCompanies } from '../../store/selectors';
import { Button, Modal } from '../../components/ui';
export function Companies() {
  const s = useStore();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  function close() {
    if (name || color !== '#5753c9') setConfirm(true);
    else setCreating(false);
  }
  const [name, setName] = useState('');
  const [color, setColor] = useState('#5753c9');
  const companies = selectCompanies(s).filter(c => c.name.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')));
  return <section className="companies">
    <div className="page-heading">
      <div>
        <span className="eyebrow">TU ESPACIO CREATIVO</span>
        <h1>Empresas</h1>
        <p>Cada marca, su historia. Todo en un solo lugar.</p>
      </div>{can(s.role, 'createCompany') && <Button className="primary" onClick={() => setCreating(true)}>
        <Plus size={16} />Crear empresa</Button>}</div>
    <div className="company-toolbar">
      <label className="search">
        <Search size={17} />
        <input aria-label="Buscar empresas" placeholder="Buscar una empresa…" value={query} onChange={e => setQuery(e.target.value)} />
      </label>
      <span>{pluralize(companies.length, 'empresa')}</span>
    </div>
    <div className="company-grid">{companies.map(c => {
      return <CompanyCard key={c.id} company={c} />;
    })}
    </div>
    {!companies.length && <div className="empty">{query ? 'No hay empresas que coincidan con tu búsqueda.' : 'No hay empresas disponibles.'}{query && <Button onClick={() => setQuery('')}>Limpiar filtros</Button>}</div>}
    <p className="footnote">Las tareas pendientes corresponden a publicaciones pendientes o en proceso del mes actual en Santiago.</p>
    {creating && <Modal title="Crear empresa de demostración" onClose={close}>
      <form onSubmit={e => { e.preventDefault(); const result = actions.createCompany(name, color); if (!result.ok) { setError(result.reason); return; } setCreating(false); setName(''); setColor('#5753c9'); setError(''); }}
      >
        {error && <p role="alert">{error}</p>}
        <label>Nombre de la empresa<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} autoFocus />
        </label>
        <label>Color de la marca<input type="color" value={color} onChange={e => setColor(e.target.value)} />
        </label>
        <Button className="primary" disabled={!name.trim()}>Crear empresa</Button>
      </form>
    {confirm && <Modal title="Descartar cambios sin guardar" onClose={() => setConfirm(false)} initialFocus=".keep-company">
        <p>Hay cambios sin guardar. ¿Quieres descartarlos?</p>
        <div className="modal-actions"><Button className="keep-company" onClick={() => setConfirm(false)}>Seguir editando</Button>
          <Button onClick={() => { setConfirm(false); setCreating(false); setName(''); setColor('#5753c9'); setError(''); }}>Descartar cambios</Button></div>
      </Modal>}
    </Modal>}</section>;
}
