import { addDays, format } from 'date-fns';
import { es } from 'date-fns/locale';
import { todayKey, zonedFormat } from '../../lib/dates';
import { dateKey, periodDays, periodRange, validDateKey } from '../../lib/periods';
import type { Post } from '../../types';
import type { Filters } from '../../store/selectors';

export function selectedPeriodDay(reference: string, view: 'mes' | 'semana', requested: string | null, today = todayKey()) {
  const { start, end } = periodRange(reference, view);
  const contains = (day: string | null): day is string => validDateKey(day) && day >= dateKey(start) && day <= dateKey(end);
  return contains(requested) ? requested : contains(today) ? today : dateKey(start);
}
export function monthCells(reference: string) {
  const days = periodDays(reference, 'mes', true);
  // Incluso febrero con cuatro semanas completas mantiene cinco filas táctiles.
  while (days.length < 35) days.push(addDays(days[days.length - 1], 1));
  return days;
}
// Recibe exclusivamente publicaciones autorizadas por los selectores del store.
export function dailyCounts(posts: Post[]) {
  const counts = new Map<string, number>();
  for (const post of posts) {
    const day = zonedFormat(post.scheduledAt, 'yyyy-MM-dd');
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}
export const indicatorLabel = (count: number) => count > 9 ? '9+' : String(count);
export const activeFilterCount = (filters: Filters) => Object.values(filters).filter(Boolean).length;
export function compactWeekLabel(reference: string) {
  const { start, end } = periodRange(reference, 'semana');
  return `${format(start, start.getFullYear() === end.getFullYear() ? 'd MMM' : 'd MMM yyyy', { locale: es })} – ${format(end, 'd MMM yyyy', { locale: es })}`;
}
