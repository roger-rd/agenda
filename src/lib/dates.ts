import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { es } from 'date-fns/locale';
export const TIME_ZONE = 'America/Santiago';
export const zonedFormat = (date: string | Date, pattern: string) => formatInTimeZone(date, TIME_ZONE, pattern, { locale: es });
export const todayKey = () => zonedFormat(new Date(), 'yyyy-MM-dd');
// Calendar arithmetic uses local noon; persisted instants use explicit Santiago conversion.
export const calendarDate = (key: string) => new Date(`${key}T12:00:00`);
export function santiagoInstant(day: string, time: string): string {
    // ISO parsing requires a two-digit hour (the demo also supplies times like 9:30).
    const normalizedTime = time.padStart(5, '0');
    return fromZonedTime(`${day}T${normalizedTime}:00`, TIME_ZONE).toISOString();
}
