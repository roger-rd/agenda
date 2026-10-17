import { ProfileMenu } from './ProfileMenu';
import { useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useMatch } from 'react-router';
import { CalendarDays, Building2, ChevronDown } from 'lucide-react';
import { actions, getStorageWarning, useStore } from '../../store';
import { selectCompanies, selectCompany } from '../../store/selectors';
import { can } from '../../store/permissions';
import { APP_NAME } from '../../lib/config';
import { zonedFormat } from '../../lib/dates';
import { Avatar, Button, Modal } from '../../components/ui';
import { Companies } from '../companies/Companies';
import { Calendar } from '../calendar/Calendar';
function CompanyRoute() { const { id = '' } = useParams(); return <Calendar key={id} companyId={id} />; }
export function Workspace() {
  const s = useStore();
  const navigate = useNavigate();
  const companies = selectCompanies(s);
  const route = useMatch('/empresa/:id');
  const active = selectCompany(s, route?.params.id ?? s.activeCompanyId) ?? companies[0];
  const [reset, setReset] = useState(false);
  const panel = can(s.role, 'viewCompanyPanel');
  const home = panel ? '/empresas' : `/empresa/${active?.id}`;
  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" to={home}>
        <span className="brand-mark">
          <CalendarDays size={22} />
        </span>
        <span>{APP_NAME}</span>
      </Link>{can(s.role, 'viewOrganization') && <div className="organization">
        <span className="eyebrow">ORGANIZACIÓN</span>
        <strong>{s.organization.name}</strong>
        <small>Planificación colaborativa</small>
      </div>}
      <div className="company-switch">
        <label htmlFor="company-switch">EMPRESA ACTIVA</label>
        <div>
          <Avatar name={active?.name ?? 'Empresa'} color={active?.color} />
          <select id="company-switch" value={active?.id ?? ''} onChange={e => { actions.setCompany(e.target.value); navigate(`/empresa/${e.target.value}`); }}
          >{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <ChevronDown size={13} />
        </div>
      </div>
      <nav>{panel && <Link to="/empresas">
        <Building2 size={18} />Empresas</Link>}{active && <Link to={`/empresa/${active.id}`}>
          <CalendarDays size={18} />Calendario</Link>}</nav>
      <ProfileMenu onReset={() => setReset(true)} />
    </aside>
    <div className="main-column">
      <header className="topbar">
        <div>
          <span className="workspace-dot" style={{ background: active?.color }} />{active?.name}</div>
        <span>{zonedFormat(new Date(), 'MMMM yyyy')}<span className="demo-tag">Demostración</span>
        </span>
      </header>{getStorageWarning() && <p role="alert" className="notice">{getStorageWarning()}</p>}<main className="main-content">
        <Routes>
          <Route path="/empresas" element={panel ? <Companies /> : <Navigate to={home} replace />} />
          <Route path="/empresa/:id" element={<CompanyRoute />} />
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="*" element={<div className="empty"><h1>404 · Página no encontrada</h1><p>Esta dirección no existe.</p><Link className="button" to={home}>Volver al inicio</Link></div>} />
        </Routes>
      </main>
    </div>{reset && <Modal title="Restablecer la demostración" onClose={() => setReset(false)}>
      <p>Se eliminarán las empresas creadas en esta demostración y se regenerará el contenido con la fecha actual.</p>
      <div className="modal-actions">
        <Button onClick={() => setReset(false)}>Cancelar</Button>
        <Button className="primary" onClick={() => { actions.reset(); setReset(false); navigate('/'); }}
        >Restablecer datos</Button>
      </div>
    </Modal>}</div>;
}
