import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from 'date-fns';
import { es } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, CalendarDays, Eye, EyeOff, SlidersHorizontal } from 'lucide-react';
import { useStore } from '../../store';
import { selectCompany, selectFilteredPosts, selectPost, selectPosts, selectResponsibleUsers, type Filters } from '../../store/selectors';
import { can } from '../../store/permissions';
import { calendarDate, todayKey, zonedFormat } from '../../lib/dates';
import { Button, FormatBadge, Modal, StatusBadge } from '../../components/ui';
import type { Post } from '../../types';
function PostCard({ post, onClick, team }: {
    post: Post;
    onClick: () => void;
    team: boolean;
}) { return <button className="post-card" onClick={onClick}><div className="post-time"><span>{zonedFormat(post.scheduledAt, 'HH:mm')}</span>{team && <span title={post.visible_para_cliente ? 'Visible para el cliente' : 'Solo equipo'} aria-label={post.visible_para_cliente ? 'Visible para el cliente' : 'Solo equipo'}>{post.visible_para_cliente ? <Eye size={12}/> : <EyeOff size={12}/>}</span>}</div><strong>{post.title}</strong><div className="post-meta"><FormatBadge format={post.format}/><StatusBadge status={post.status}/></div></button>; }
export function Calendar({ companyId }: {
    companyId: string;
}) {
    const s = useStore();
    const [month, setMonth] = useState(() => startOfMonth(calendarDate(todayKey())));
    const [filters, setFilters] = useState<Filters>({ status: '', responsible: '', format: '' });
    const [params, setParams] = useSearchParams();
    const day = params.get('dia');
    const detail = params.get('publicacion');
    const company = selectCompany(s, companyId);
    const posts = selectFilteredPosts(s, companyId, filters);
    const allowed = selectPosts(s, companyId);
    const selected = detail ? selectPost(s, detail) : undefined;
    const post = selected?.companyId === companyId ? selected : undefined;
    const days = eachDayOfInterval({ start: startOfWeek(month, { weekStartsOn: 1 }), end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }) });
    const close = () => setParams({});
    const team = can(s.role, 'viewTeamVisibility');
    const monthCount = posts.filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM') === format(month, 'yyyy-MM')).length;
    if (!company)
        return <div className="empty"><h1>No disponible</h1><p>No tienes acceso a este espacio.</p></div>;
    return <section className="calendar-page"><div className="page-heading"><div><span className="eyebrow">ESPACIO DE TRABAJO</span><h1>Calendario de contenido</h1><p>Una mirada clara a lo que viene para {company.name}.</p></div><span className="month-pill"><CalendarDays size={16}/>Mes</span></div><div className="calendar-surface"><div className="calendar-toolbar"><div className="month-controls"><h2>{format(month, 'MMMM yyyy', { locale: es })}</h2><Button aria-label="Mes anterior" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={17}/></Button><Button aria-label="Mes siguiente" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={17}/></Button><Button onClick={() => setMonth(startOfMonth(calendarDate(todayKey())))}>Hoy</Button></div><span className="muted">{monthCount} publicaciones · Hora de Santiago</span></div><div className="filters"><SlidersHorizontal size={16}/><label><span className="sr-only">Estado</span><select aria-label="Estado" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value as Filters['status'] })}><option value="">Todos los estados</option>{[...new Set(allowed.map(p => p.status))].map(v => <option key={v}>{v}</option>)}</select></label><label><span className="sr-only">Responsable</span><select aria-label="Responsable" value={filters.responsible} onChange={e => setFilters({ ...filters, responsible: e.target.value })}><option value="">Todos los responsables</option>{selectResponsibleUsers(s, companyId).map(u => <option key={u.id} value={u.id}>{u.name}{u.example ? ' (datos de ejemplo)' : ''}</option>)}</select></label><label><span className="sr-only">Formato</span><select aria-label="Formato" value={filters.format} onChange={e => setFilters({ ...filters, format: e.target.value as Filters['format'] })}><option value="">Todos los formatos</option>{[...new Set(allowed.map(p => p.format))].map(v => <option key={v}>{v}</option>)}</select></label>{Object.values(filters).some(Boolean) && <Button onClick={() => setFilters({ status: '', responsible: '', format: '' })}>Limpiar filtros</Button>}</div><div className="weekdays">{['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'].map(d => <span key={d}>{d}</span>)}</div><div className="calendar-scroll"><div className="calendar-grid">{days.map(date => { const key = format(date, 'yyyy-MM-dd'); const daily = posts.filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM-dd') === key); return <div className={`day ${date.getMonth() !== month.getMonth() ? 'outside' : ''}`} key={key}><button className={`day-number ${key === todayKey() ? 'today' : ''}`} aria-label={`Ver publicaciones del ${format(date, 'd MMMM yyyy', { locale: es })}`} onClick={() => setParams({ dia: key })}>{format(date, 'd')}</button>{daily.slice(0, 3).map(p => <PostCard key={p.id} post={p} team={team} onClick={() => setParams({ publicacion: p.id })}/>)}{daily.length > 3 && <button className="more" onClick={() => setParams({ dia: key })}>Ver más (+{daily.length - 3})</button>}</div>; })}</div></div><div className="calendar-footer"><span>{team ? 'Visibilidad: ojo = cliente · ojo tachado = solo equipo' : 'Contenido compartido contigo'}</span><span>Zona horaria: America/Santiago</span></div></div>{day && <Modal title={/^\d{4}-\d{2}-\d{2}$/.test(day) && !isNaN(calendarDate(day).getTime()) ? format(calendarDate(day), "d 'de' MMMM", { locale: es }) : 'Día no disponible'} onClose={close}><p className="muted">Publicaciones del día · Se aplican los filtros seleccionados.</p><div className="day-list">{posts.filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM-dd') === day).map(p => <PostCard key={p.id} post={p} team={team} onClick={() => setParams({ publicacion: p.id })}/>)}</div>{!posts.some(p => zonedFormat(p.scheduledAt, 'yyyy-MM-dd') === day) && <p className="empty">No hay publicaciones para este día.</p>}</Modal>}{detail && <Modal title={post ? 'Detalle de la publicación' : 'No disponible'} onClose={close}>{post ? <><div className="detail-badges"><StatusBadge status={post.status}/><FormatBadge format={post.format}/></div><h3>{post.title}</h3><p>{post.description}</p><dl><dt>Fecha y hora</dt><dd>{zonedFormat(post.scheduledAt, "d 'de' MMMM yyyy · HH:mm")} (Santiago)</dd><dt>Responsable</dt><dd>{s.users.find(u => u.id === post.responsibleId)?.name}{s.users.find(u => u.id === post.responsibleId)?.example ? ' · datos de ejemplo' : ''}</dd>{team && <><dt>Visibilidad</dt><dd>{post.visible_para_cliente ? 'Visible para el cliente y el equipo' : 'Solo equipo'}</dd></>}{post.confirmadoEn && <><dt>Publicación confirmada</dt><dd>{s.users.find(u => u.id === post.confirmadoPor)?.name} · {zonedFormat(post.confirmadoEn, 'dd/MM/yyyy HH:mm')}</dd></>}</dl><div className="notice">Vista de solo lectura · Datos de demostración</div></> : <p>Esta publicación no está disponible para tu perfil.</p>}</Modal>}</section>;
}
