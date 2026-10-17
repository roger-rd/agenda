import { addDays, format, startOfMonth } from 'date-fns';
import type { State, PostFormat, PostStatus } from '../types';
import { calendarDate, todayKey, santiagoInstant } from '../lib/dates';
export function generateDemo(): State {
    const companies = ['RDRP Te Invito', 'Ecoplanes', 'Girasol', 'Café Tacuba'].map((name, i) => ({ id: `company-${i}`, organizationId: 'org-1', name, color: ['#5753c9', '#21836c', '#bf8924', '#a45b47'][i] }));
    const titles = [['Una invitación a conectar', 'Detrás de cada encuentro', 'Ideas para tu próximo evento', 'Momentos que nos reúnen', 'Conoce nuestra propuesta', 'Un encuentro para recordar'], ['Pequeños cambios, gran impacto', 'Una escapada consciente', 'Naturaleza en primera persona', 'Tu próxima ruta verde', 'Consejos para viajar ligero', 'Descubre un nuevo destino'], ['Un poco de sol para tu día', 'Conoce nuestra colección', 'Los detalles hacen la diferencia', 'Inspiración de temporada', 'Así creamos para ti', 'Nuestra comunidad florece'], ['El ritual del primer café', 'Del grano a tu taza', 'Una pausa que se disfruta', 'Conoce a nuestro barista', 'Sabores de la casa', 'Tu rincón favorito']];
    const base = startOfMonth(calendarDate(todayKey()));
    const posts = companies.flatMap((company, c) => Array.from({ length: 64 }, (_, i) => {
        const day = format(addDays(base, i - 12), 'yyyy-MM-dd');
        const status: PostStatus = (['Pendiente', 'En proceso', 'Completado', 'Subido'] as const)[i % 4];
        return { id: `post-${c}-${i}`, companyId: company.id, title: titles[c][i % 6], description: 'Contenido de demostración. Una propuesta cercana para conectar con la comunidad, compartir nuestra historia e invitar a participar. Preparar el material visual y revisar el mensaje antes de su publicación.', scheduledAt: santiagoInstant(day, `${[9, 11, 16, 18][i % 4]}:30`), format: (['Post', 'Carrusel', 'Reel', 'Historia'] as PostFormat[])[(i + Math.floor(i / 4)) % 4], status, responsibleId: i % 3 === 0 ? 'edison' : c < 2 ? 'ana' : 'pablo', visible_para_cliente: i % 3 !== 0, attachments: [], ...(status === 'Subido' ? { confirmadoPor: 'edison', confirmadoEn: santiagoInstant(day, '19:00') } : {}) };
    }));
    // A busy day exercises overflow for both team and client views.
    for (let i = 0; i < 5; i++)
        posts.push({ ...posts[15 + i], id: `busy-${i}`, scheduledAt: santiagoInstant(todayKey(), `${10 + i}:00`), visible_para_cliente: i !== 0 });
    const comments = [
        { id: 'comment-demo-1', postId: 'busy-1', authorId: 'ana',
            body: 'La propuesta está lista para revisar.',
            createdAt: new Date(Date.now() - 3600000).toISOString() },
        { id: 'comment-demo-2', postId: 'busy-1', authorId: 'roger',
            body: 'Gracias, el enfoque representa muy bien nuestra marca.',
            createdAt: new Date(Date.now() - 1800000).toISOString() },
    ];
    return { version: 2, comments, organization: { id: 'org-1', name: 'Estudio Creativo' }, companies, users: [{ id: 'edison', name: 'Edison Valera', role: 'community_manager', example: false }, { id: 'roger', name: 'Roger Rodríguez', role: 'client', example: false }, { id: 'ana', name: 'Ana Torres', role: 'worker', example: true }, { id: 'pablo', name: 'Pablo Soto', role: 'worker', example: true }], memberships: [{ id: 'm1', userId: 'roger', companyId: 'company-0' }, { id: 'm2', userId: 'ana', companyId: 'company-0' }, { id: 'm3', userId: 'ana', companyId: 'company-1' }, { id: 'm4', userId: 'pablo', companyId: 'company-2' }, { id: 'm5', userId: 'pablo', companyId: 'company-3' }], posts, role: 'community_manager', authenticated: false, activeCompanyId: 'company-0' };
}
