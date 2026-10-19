import { pluralize } from '../../../lib/pluralize';
import { dayCountLabel, todayKey, zonedFormat } from '../../../lib/dates';
import { dateKey, periodDays, periodLabel } from '../../../lib/periods';
import type { ViewProps } from '../viewTypes';
export function YearView({ reference, posts, onMonth }: ViewProps & { onMonth: (month: string) => void }) {
  const counts = new Map<string, number>();
  for (const post of posts) {
    const key = zonedFormat(post.scheduledAt, 'yyyy-MM-dd');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return <div className="year-grid">{Array.from({ length: 12 }, (_, index) => {
    const month = `${reference.slice(0, 4)}-${String(index + 1).padStart(2, '0')}-01`;
    const total = posts.filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM') === month.slice(0, 7)).length;
    return <button className="mini-month" key={month} onClick={() => onMonth(month)} aria-label={`Abrir ${periodLabel(month, 'mes')}, ${pluralize(total, 'publicación', 'publicaciones')}`}>
      <strong>{periodLabel(month, 'mes')}</strong>
      <small>{pluralize(total, 'publicación', 'publicaciones')}</small>
      <div className="mini-grid" aria-hidden="true">{['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(d => <span key={d}>{d}</span>)}</div>
      <div className="mini-grid">{periodDays(month, 'mes', true).map(date => {
        const key = dateKey(date);
        const count = counts.get(key) ?? 0;
        return <span key={key} className={`${key.slice(0, 7) !== month.slice(0, 7) ? 'outside' : ''} ${count ? 'has-posts' : ''}`} aria-label={dayCountLabel(key, count, key === todayKey())}>{date.getDate()}{count > 0 && <span aria-hidden="true">•</span>}</span>;
      })}</div>
    </button>;
  })}</div>;
}
