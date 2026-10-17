import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Search, Plus, ArrowUpRight, CalendarDays, ListTodo } from 'lucide-react';
import { actions, useStore } from '../../store';
import { can } from '../../store/permissions';
import { selectCompanies, selectCounts } from '../../store/selectors';
import { Avatar, Button, Modal } from '../../components/ui';
export function Companies() {
    const s = useStore();
    const navigate = useNavigate();
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [color, setColor] = useState('#5753c9');
    const companies = selectCompanies(s).filter(c => c.name.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')));
    return <section className="companies"><div className="page-heading"><div><span className="eyebrow">TU ESPACIO CREATIVO</span><h1>Empresas</h1><p>Cada marca, su historia. Todo en un solo lugar.</p></div>{can(s.role, 'createCompany') && <Button className="primary" onClick={() => setCreating(true)}><Plus size={16}/>Crear empresa</Button>}</div><div className="company-toolbar"><label className="search"><Search size={17}/><input aria-label="Buscar empresas" placeholder="Buscar una empresa…" value={query} onChange={e => setQuery(e.target.value)}/></label><span>{companies.length} empresas</span></div><div className="company-grid">{companies.map(c => { const counts = selectCounts(s, c.id); return <button className="company-card" key={c.id} onClick={() => { actions.setCompany(c.id); navigate(`/empresa/${c.id}`); }}><div className="card-top"><Avatar name={c.name} color={c.color}/><ArrowUpRight size={20}/></div><h2>{c.name}</h2><p>Espacio de contenido</p><div className="card-counts"><span><CalendarDays size={16}/><strong>{counts.planned}</strong> previstas este mes</span><span><ListTodo size={16}/><strong>{counts.pending}</strong> tareas pendientes</span></div><div className="card-foot">Abrir calendario <span>→</span></div></button>; })}</div>{!companies.length && <div className="empty">No hay empresas que coincidan con tu búsqueda.</div>}<p className="footnote">Las tareas pendientes corresponden a publicaciones pendientes o en proceso.</p>{creating && <Modal title="Crear empresa de demostración" onClose={() => setCreating(false)}><form onSubmit={e => { e.preventDefault(); actions.createCompany(name, color); setCreating(false); setName(''); }}><label>Nombre de la empresa<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} autoFocus/></label><label>Color de la marca<input type="color" value={color} onChange={e => setColor(e.target.value)}/></label><Button className="primary" disabled={!name.trim()}>Crear empresa</Button></form></Modal>}</section>;
}
