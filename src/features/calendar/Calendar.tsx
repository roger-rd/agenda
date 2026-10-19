import { useDesktop } from '../../lib/useDesktop';
import { DayAgenda } from './DayAgenda';
import { compactWeekLabel, selectedPeriodDay } from './compactCalendar';
import type { Post } from '../../types';
import { pluralize } from '../../lib/pluralize';
import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui';
import { todayKey } from '../../lib/dates';
import { movePeriod, periodLabel, readPeriod, resolveView, viewLabels, type View } from '../../lib/periods';
import { useStore } from '../../store';
import { can } from '../../store/permissions';
import { emptyFilters, selectCompany, selectRequestedPost, selectFilteredPosts, selectViewPosts } from '../../store/selectors';
import { Board } from '../board/Board';
import { FiltersBar } from './FiltersBar';
import { MonthView } from './MonthView/MonthView';
import { WeekView } from './WeekView/WeekView';
import { YearView } from './YearView/YearView';
import { PostForm } from '../posts/PostForm';
import { PostDetail } from './PostDetail';

export function Calendar({ companyId }: { companyId: string }) {
  const state = useStore();
  const desktop = useDesktop();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [creatingDay, setCreatingDay] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState(false);
  const [filters, setFilters] = useState(emptyFilters);
  const view = resolveView(params.get('vista'), state.role);
  const reference = readPeriod(params.get('fecha'));
  const company = selectCompany(state, companyId);
  const posts = selectViewPosts(state, companyId, filters, reference, view);
  const detail = params.get('publicacion');
  const selected = selectedPeriodDay(reference, view === 'semana' ? 'semana' : 'mes', params.get('dia'));

  const unavailable = detail !== null && !selectRequestedPost(state, companyId, detail);

  // Normalize missing/invalid routes and disallow a client's board URL.
  useEffect(() => {
    if (params.get('vista') === view && params.get('fecha') === reference && !unavailable) return;
    const next = new URLSearchParams(params);
    next.set('vista', view);
    next.set('fecha', reference);
    if (unavailable) next.delete('publicacion');
    setParams(next, { replace: true, state: { unavailablePost: unavailable || location.state?.unavailablePost } });
  }, [params, reference, setParams, view, unavailable, location.state]);

  function patch(values: Record<string, string | null>, replace = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null) next.delete(key); else next.set(key, value);
    }
    setParams(next, { replace });
  }
  function navigate(view: View, date = reference, day: string | null = null) {
    patch({ vista: view, fecha: date, dia: day ?? (!desktop && (view === 'mes' || view === 'semana') ? selectedPeriodDay(date, view, null) : null) });
  }
  function onSaved(post: Post) {
    setSaveNotice(!!((filters.status && filters.status !== post.status)
      || (filters.format && filters.format !== post.format)
      || (filters.responsible && filters.responsible !== post.responsibleId)));
  }
  function clearFilters() { setFilters(emptyFilters); setSaveNotice(false); }
  const props = { onCreate: can(state.role, 'createPost') ? setCreatingDay : undefined, reference, posts, users: state.users, onOpen: (id: string) => patch({ publicacion: id }) };
  if (!company) return <div className="empty">
    <h1>No disponible</h1>
    <p>No tienes acceso a este espacio.</p>{location.state?.unavailablePost && <p role="status">Publicación no disponible</p>}{detail && <PostDetail onSaved={onSaved} id={detail} companyId={companyId} onClose={() => patch({ publicacion: null })} />}</div>;
  return <section className={`calendar-page ${view !== 'tablero' ? 'responsive-calendar' : 'responsive-board'}`}>
    {location.state?.unavailablePost && <p className="notice" role="status">Publicación no disponible</p>}
    <div className="page-heading">
      <div>
        <span className="eyebrow">ESPACIO DE TRABAJO</span>
        <h1>Calendario de contenido</h1>
        <p>Una mirada clara a lo que viene para {company.name}.</p>
      </div>
      {can(state.role, 'createPost') && <Button className="primary"
        onClick={() => setCreatingDay(reference)}>Nueva publicación</Button>}
      <div className="view-switch" role="group" aria-label="Vista del calendario">{(Object.keys(viewLabels) as View[]).filter(v => v !== 'tablero' || can(state.role, 'changeStatus')).map(v =>
        <Button key={v} aria-pressed={v === view} className={v === view ? 'primary' : ''} onClick={() => navigate(v)}>{viewLabels[v]}</Button>)}</div>
    </div>
    <div className="calendar-surface">
      <div className="calendar-toolbar">
        <div className="month-controls">
          <h2 aria-live="polite">{!desktop && view === 'semana' ? compactWeekLabel(reference) : periodLabel(reference, view)}</h2>
          <Button aria-label="Periodo anterior" onClick={() => navigate(view, movePeriod(reference, view, -1))}>
            <ChevronLeft size={17} />
          </Button>
          <Button aria-label="Periodo siguiente" onClick={() => navigate(view, movePeriod(reference, view, 1))}>
            <ChevronRight size={17} />
          </Button>
          <Button onClick={() => navigate(view, todayKey())}>Hoy</Button>
        </div>
        <span className="muted">{pluralize(posts.length, 'publicación', 'publicaciones')} · {view === 'tablero' ? 'Tablero del mes' : viewLabels[view]}</span>
      </div>
      <FiltersBar total={posts.length} companyId={companyId} filters={filters} onChange={next => { setFilters(next); setSaveNotice(false); }} />
      <div aria-live="polite">{saveNotice && <div className="notice">La publicación se guardó pero no coincide con los filtros activos. <Button onClick={clearFilters}>Limpiar filtros</Button></div>}</div>
      {!posts.length && <div className="notice" role="status">
        {Object.values(filters).some(Boolean) ? <>No hay publicaciones que coincidan con los filtros en este periodo. <Button onClick={clearFilters}>Limpiar filtros</Button></> : 'No hay publicaciones en este periodo.'}
      </div>}
      {(view === 'mes' || view === 'semana') && <DayAgenda {...props} posts={selectFilteredPosts(state, companyId, filters)} view={view} selected={selected} onSelect={day => patch({ dia: day, ...(view === 'mes' && day.slice(0, 7) !== reference.slice(0, 7) ? { fecha: day } : {}) }, true)} />}
      {view === 'mes' && <MonthView {...props} posts={selectFilteredPosts(state, companyId, filters)} onDay={day => navigate('semana', day, day)} />}
      {view === 'semana' && <WeekView {...props} highlighted={params.get('dia')} />}
      {view === 'anio' && <YearView {...props} onMonth={month => navigate('mes', month)} />}
      {view === 'tablero' && <Board {...props} />}
      <div className="calendar-footer">
        <span>{can(state.role, 'viewTeamVisibility') ? 'Visibilidad: ojo = cliente · ojo tachado = solo equipo' : 'Contenido compartido contigo'}</span>
        <span>Zona horaria: America/Santiago</span>
      </div>
    </div>
    {creatingDay && <PostForm onSaved={onSaved} companyId={companyId} day={creatingDay} onClose={() => setCreatingDay(null)} />}
    {detail !== null && !unavailable && <PostDetail onSaved={onSaved} id={detail} companyId={companyId} onClose={() => patch({ publicacion: null })} />}
  </section>;
}
