import { pluralize } from '../../../lib/pluralize';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { todayKey, zonedFormat } from '../../../lib/dates';
import { dateKey, periodDays } from '../../../lib/periods';
import { PostCard } from '../PostCard';
import type { ViewProps } from '../viewTypes';
export function MonthView({ reference, onCreate, posts, onOpen, onDay }: ViewProps & { onDay: (day: string) => void }) {
  return <>
    <div className="weekdays">{['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="calendar-scroll">
      <div className="calendar-grid">{periodDays(reference, 'mes', true).map(date => {
        const key = dateKey(date);
        const daily = posts.filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM-dd') === key);
        return <div className={`day ${key.slice(0, 7) !== reference.slice(0, 7) ? 'outside' : ''}`} key={key}>
          <button className={`day-number ${key === todayKey() ? 'today' : ''}`} aria-label={`Ver semana del ${format(date, 'd MMMM yyyy', { locale: es })}`} onClick={() => onDay(key)}>{date.getDate()}</button>
          {onCreate && <button className="add-day" aria-label={`Agregar publicación el ${key}`}
            onClick={() => onCreate(key)}>+ Agregar</button>}
          {daily.slice(0, 3).map(post => <PostCard key={post.id} post={post} onOpen={onOpen} />)}
          {daily.length > 3 && <button className="more" onClick={() => onDay(key)}>Ver {pluralize(daily.length - 3, 'publicación', 'publicaciones')} más</button>}
        </div>;
      })}</div>
    </div>
  </>;
}
