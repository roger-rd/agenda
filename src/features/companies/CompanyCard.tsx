import { pluralize } from '../../lib/pluralize';
import { useNavigate } from 'react-router';
import { ArrowUpRight, CalendarDays, ListTodo } from 'lucide-react';
import { actions, useStore } from '../../store';
import { selectCounts } from '../../store/selectors';
import { Avatar } from '../../components/ui';
import type { Company } from '../../types';
export function CompanyCard({ company }: { company: Company }) {
  const state = useStore();
  const navigate = useNavigate();
  const counts = selectCounts(state, company.id);
  return <button className="company-card" onClick={() => { actions.setCompany(company.id); navigate(`/empresa/${company.id}`); }}>
    <div className="card-top">
      <Avatar name={company.name} color={company.color} />
      <ArrowUpRight size={20} />
    </div>
    <h2>{company.name}</h2>
    <p>Espacio de contenido</p>
    <div className="card-counts">
      <span>
        <CalendarDays size={16} />
        {pluralize(counts.planned, 'publicación prevista', 'publicaciones previstas')} este mes</span>
      <span>
        <ListTodo size={16} />
        {pluralize(counts.pending, 'tarea pendiente', 'tareas pendientes')} este mes</span>
    </div>
    <div className="card-foot">Abrir calendario <span>→</span>
    </div>
  </button>;

}
