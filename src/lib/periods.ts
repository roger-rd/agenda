import { addDays, addMonths, addYears, eachDayOfInterval, endOfMonth, endOfWeek, endOfYear, format, startOfMonth, startOfWeek, startOfYear } from 'date-fns';
import { es } from 'date-fns/locale';
import { calendarDate, todayKey } from './dates';
import type { Role } from '../types';

export type View = 'anio' | 'mes' | 'semana' | 'tablero';
export const viewLabels: Record<View, string> = { anio: 'Año', mes: 'Mes', semana: 'Semana', tablero: 'Tablero' };
export const dateKey = (date: Date) => format(date, 'yyyy-MM-dd');
export function validDateKey(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(calendarDate(value).getTime()) && dateKey(calendarDate(value)) === value;
}
export function resolveView(value: string | null, role: Role): View {
  if (value === 'tablero') return role === 'client' ? 'semana' : 'tablero';
  if (value === 'anio' || value === 'mes' || value === 'semana') return value;
  return role === 'client' ? 'semana' : 'mes';
}
export function periodRange(reference: string, view: View) {
  const date = calendarDate(reference);
  if (view === 'semana') return { start: startOfWeek(date, { weekStartsOn: 1 }), end: endOfWeek(date, { weekStartsOn: 1 }) };
  if (view === 'anio') return { start: startOfYear(date), end: endOfYear(date) };
  return { start: startOfMonth(date), end: endOfMonth(date) };
}
export function periodDays(reference: string, view: View, padded = false) {
  const range = periodRange(reference, view);
  return eachDayOfInterval(padded ? { start: startOfWeek(range.start, { weekStartsOn: 1 }), end: endOfWeek(range.end, { weekStartsOn: 1 }) } : range);
}
export function movePeriod(reference: string, view: View, direction: number) {
  const date = calendarDate(reference);
  return dateKey(view === 'semana' ? addDays(date, 7 * direction) : view === 'anio' ? addYears(date, direction) : addMonths(date, direction));
}
export function periodLabel(reference: string, view: View) {
  const { start, end } = periodRange(reference, view);
  if (view === 'semana') return `${format(start, 'd MMM yyyy', { locale: es })} – ${format(end, 'd MMM yyyy', { locale: es })}`;
  return format(start, view === 'anio' ? 'yyyy' : 'MMMM yyyy', { locale: es });
}
export function readPeriod(value: string | null) { return validDateKey(value) ? value : todayKey(); }
