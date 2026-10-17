import { SlidersHorizontal } from 'lucide-react';
import { Button } from '../../components/ui';
import { useStore } from '../../store';
import { emptyFilters, selectAssignableUsers, type Filters } from '../../store/selectors';
import { formats } from '../posts/validation';
import { statuses } from '../../store/transitions';
export function FiltersBar({ companyId, filters, onChange }: { companyId: string; filters: Filters; onChange: (filters: Filters) => void }) {
  const state = useStore();
  return <div className="filters">
    <SlidersHorizontal size={16} />
    <select aria-label="Filtrar por estado" value={filters.status} onChange={e => onChange({ ...filters, status: e.target.value as Filters['status'] })}>
      <option value="">Todos los estados</option>{statuses.map(status => <option key={status}>{status}</option>)}
    </select>
    <select aria-label="Filtrar por responsable" value={filters.responsible} onChange={e => onChange({ ...filters, responsible: e.target.value })}>
      <option value="">Todos los responsables</option>{selectAssignableUsers(state, companyId).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
    </select>
    <select aria-label="Filtrar por formato" value={filters.format} onChange={e => onChange({ ...filters, format: e.target.value as Filters['format'] })}>
      <option value="">Todos los formatos</option>{formats.map(value => <option key={value}>{value}</option>)}
    </select>
    {Object.values(filters).some(Boolean) && <Button onClick={() => onChange(emptyFilters)}>Limpiar filtros</Button>}
  </div>;
}
