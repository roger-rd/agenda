import { pluralize } from '../../../lib/pluralize';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { todayKey, zonedFormat } from '../../../lib/dates';
import { dateKey, periodDays } from '../../../lib/periods';
import { PostCard } from '../PostCard';
import type { ViewProps } from '../viewTypes';
export function WeekView({ reference, onCreate, posts, users, onOpen, highlighted }: ViewProps & { highlighted: string | null }) {
  return <div className="week-grid">{periodDays(reference, 'semana').map(date => {
    const key = dateKey(date);
    const daily = posts.filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM-dd') === key);
    return <section key={key} className={`week-day ${key === highlighted ? 'highlighted' : ''}`} aria-label={format(date, 'EEEE d MMMM', { locale: es })}>
      <header className={key === todayKey() ? 'current-day' : ''}>
        <strong>{format(date, 'EEEE', { locale: es })}</strong>
        <span>{format(date, 'dd/MM')}{key === todayKey() ? ' · Hoy' : ''}</span>
        <small>{pluralize(daily.length, 'publicación', 'publicaciones')}{key === highlighted ? ' · Seleccionado' : ''}</small>
      </header>
{onCreate && <button className="add-day" aria-label={`Agregar publicación el ${key}`}
            onClick={() => onCreate(key)}>+ Agregar</button>}
                <div className="column-scroll">{daily.map(post => <PostCard key={post.id} post={post} expanded responsible={users.find(u => u.id === post.responsibleId)?.name} onOpen={onOpen} />)}
        {!daily.length && <p className="column-empty">Sin publicaciones</p>}
      </div>
    </section>;
  })}</div>;
}
