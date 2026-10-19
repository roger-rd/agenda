import { useSheetScrollLock } from '../../lib/useSheetScrollLock';
import { useEffect, useState } from 'react';
import { isDesktop, useDesktop } from '../../lib/useDesktop';
import { pluralize } from '../../lib/pluralize';
import { activeFilterCount } from './compactCalendar';
import { SlidersHorizontal } from 'lucide-react';
import { Button, Modal } from '../../components/ui';
import { useStore } from '../../store';
import { emptyFilters, selectAssignableUsers, type Filters } from '../../store/selectors';
import { formats } from '../posts/validation';
import { statuses } from '../../store/transitions';
export function FiltersBar({ companyId, filters, onChange, total }: { total: number; companyId: string; filters: Filters; onChange: (filters: Filters) => void }) {
  const state = useStore();
  const desktop = useDesktop();
  const [requestedOpen, setOpen] = useState(false);
  const open = requestedOpen && !desktop;
  if (requestedOpen && desktop) setOpen(false);
  const active = activeFilterCount(filters);
  useSheetScrollLock(open);
  useEffect(() => {
    if (!open) return;
    return () => {
      // El disparador móvil queda oculto si el cierre se debe al breakpoint.
      if (isDesktop())
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.filters select')?.focus());
    };
  }, [open]);
  const controls = <>
    <select aria-label="Filtrar por estado" value={filters.status} onChange={e => onChange({ ...filters, status: e.target.value as Filters['status'] })}>
      <option value="">Todos los estados</option>{statuses.map(status => <option key={status}>{status}</option>)}
    </select>
    <select aria-label="Filtrar por responsable" value={filters.responsible} onChange={e => onChange({ ...filters, responsible: e.target.value })}>
      <option value="">Todos los responsables</option>{selectAssignableUsers(state, companyId).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
    </select>
    <select aria-label="Filtrar por formato" value={filters.format} onChange={e => onChange({ ...filters, format: e.target.value as Filters['format'] })}>
      <option value="">Todos los formatos</option>{formats.map(value => <option key={value}>{value}</option>)}
    </select>
  </>;
  return <>
    <div className="filters desktop-filters"><SlidersHorizontal size={16} />{controls}
      {active > 0 && <Button onClick={() => onChange(emptyFilters)}>Limpiar filtros</Button>}
    </div>
    <div className="compact-filter-trigger"><Button aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Filtros, ${active} activos`} onClick={() => setOpen(true)}>
      <SlidersHorizontal size={18} />Filtros{active > 0 ? ` · ${active}` : ''}</Button></div>
    {open && <Modal title="Filtros" className="filters-sheet" initialFocus="select" onClose={() => setOpen(false)}>
      <div className="sheet-controls">{controls}
        <Button disabled={!active} onClick={() => onChange(emptyFilters)}>Limpiar filtros</Button>
        <Button className="primary" onClick={() => setOpen(false)}>Ver {pluralize(total, 'publicación', 'publicaciones')}</Button>
        <Button onClick={() => setOpen(false)}>Cerrar</Button>
      </div>
    </Modal>}
  </>;
}
