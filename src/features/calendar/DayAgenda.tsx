import { useLayoutEffect, useRef } from 'react';
import { scrollIntoViewIfNeeded } from '../../lib/scroll';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Button } from '../../components/ui';
import { calendarDate, dayCountLabel, todayKey, zonedFormat } from '../../lib/dates';
import { dateKey, periodDays } from '../../lib/periods';
import { pluralize } from '../../lib/pluralize';
import { dailyCounts, indicatorLabel, monthCells } from './compactCalendar';
import { PostCard } from './PostCard';
import type { ViewProps } from './viewTypes';

const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
export function DayAgenda({ reference, posts, users, onOpen, onCreate, view, selected, onSelect }: ViewProps & {
  view: 'mes' | 'semana'; selected: string; onSelect: (day: string) => void;
}) {
  const heading = useRef<HTMLElement>(null);
  const requestedDay = useRef<string | null>(null);
  // Solo una selección explícita autoriza scroll tras confirmar la navegación.
  useLayoutEffect(() => {
    if (requestedDay.current === selected) scrollIntoViewIfNeeded(heading.current);
    requestedDay.current = null;
  }, [selected, reference]);
  const days = view === 'mes' ? monthCells(reference) : periodDays(reference, 'semana');
  const counts = dailyCounts(posts);
  const daily = posts.filter(post => zonedFormat(post.scheduledAt, 'yyyy-MM-dd') === selected)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return <div className={`compact-calendar compact-${view}`}>
    {view === 'mes' && <div className="compact-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>}
    <div className="compact-days">{days.map((date, index) => {
      const day = dateKey(date);
      const count = counts.get(day) ?? 0;
      const today = day === todayKey();
      return <button key={day} className={`compact-day ${day.slice(0, 7) !== reference.slice(0, 7) ? 'outside' : ''}`}
        aria-pressed={day === selected} aria-current={today ? 'date' : undefined}
        aria-label={dayCountLabel(day, count, today, true)}
        onClick={() => {
          if (day === selected) scrollIntoViewIfNeeded(heading.current);
          else requestedDay.current = day;
          onSelect(day);
        }}>
        {view === 'semana' && <span>{weekdays[index]}</span>}
        <strong>{date.getDate()}{today && <span aria-hidden="true" className="today-mark">•</span>}</strong>
        {count > 0 && <span className="day-count" aria-hidden="true">{indicatorLabel(count)}</span>}
        {view === 'mes' && <span className="tablet-markers" aria-hidden="true">{posts.filter(post => zonedFormat(post.scheduledAt, 'yyyy-MM-dd') === day).slice(0, 2).map(post => <span key={post.id}>• {post.title}</span>)}</span>}
      </button>;
    })}</div>
    <section className="day-agenda" aria-label="Agenda del día seleccionado">
      <header ref={heading}><div><h3>{format(calendarDate(selected), "EEEE d 'de' MMMM", { locale: es })}{selected === todayKey() ? ' · Hoy' : ''}</h3>
        <p aria-live="polite">{pluralize(daily.length, 'publicación', 'publicaciones')}</p></div>
        {onCreate && <Button className="primary" onClick={() => onCreate(selected)}>Agregar publicación</Button>}
      </header>
      <div className="agenda-cards">{daily.map(post => <PostCard key={post.id} post={post} expanded responsible={users.find(user => user.id === post.responsibleId)?.name} onOpen={onOpen} />)}</div>
      {!daily.length && <p className="agenda-empty" role="status">No hay publicaciones este día</p>}
    </section>
  </div>;
}
