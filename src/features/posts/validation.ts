import type { Attachment, Post, State } from '../../types';
import { santiagoInstant, zonedFormat } from '../../lib/dates';
import { validDateKey } from '../../lib/periods';
import { selectAssignableUsers } from '../../store/selectors';
import { statuses } from '../../store/transitions';

export const formats = ['Post', 'Carrusel', 'Reel', 'Historia'] as const;
export type PostInput = Omit<Post, 'id' | 'confirmadoPor' | 'confirmadoEn'>;
export type Draft = Omit<PostInput, 'scheduledAt'> & { day: string; time: string };
export type Errors = Partial<Record<keyof Draft, string>>;
export function validateDraft(draft: Draft, state: State): Errors {
  const errors: Errors = {};
  if (!draft.title.trim() || draft.title.length > 120)
    errors.title = 'Escribe un título de entre 1 y 120 caracteres.';
  if (!validDateKey(draft.day)) errors.day = 'Introduce una fecha real.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) errors.time = 'Introduce una hora válida (00:00–23:59).';
  if (!errors.day && !errors.time) {
    try {
      if (zonedFormat(santiagoInstant(draft.day, draft.time), 'yyyy-MM-dd HH:mm')
        !== `${draft.day} ${draft.time}`) errors.time = 'Esta hora no existe en America/Santiago por el cambio de horario.';
    } catch { errors.day = 'Introduce una fecha y hora válidas.'; }
  }
  if (!selectAssignableUsers(state, draft.companyId).some(u => u.id === draft.responsibleId))
    errors.responsibleId = 'Selecciona un responsable autorizado para esta empresa.';
  if (!formats.includes(draft.format)) errors.format = 'Selecciona un formato válido.';
  if (!statuses.includes(draft.status)) errors.status = 'Selecciona un estado válido.';
  if (draft.instagramUrl?.trim()) {
    try {
      const url = new URL(draft.instagramUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch { errors.instagramUrl = 'Introduce una URL completa http o https.'; }
  }
  if (draft.attachments.length > 4 || draft.attachments.some(a => attachmentError(a)))
    errors.attachments = 'Se permiten hasta 4 imágenes de 5 MB cada una.';
  return errors;
}
export const toInput = ({ day, time, ...draft }: Draft): PostInput => ({
  ...draft, title: draft.title.trim(), instagramUrl: draft.instagramUrl?.trim(),
  scheduledAt: santiagoInstant(day, time), attachments: draft.attachments.map(metadata),
});
export function attachmentError(file: { size: number; mimeType: string }): string {
  if (!file.mimeType.startsWith('image/')) return 'El archivo no es una imagen.';
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > 5 * 1024 * 1024)
    return 'La imagen supera el máximo de 5 MB.';
  return '';
}
export const metadata = (a: Attachment): Attachment => ({
  id: a.id, name: a.name, size: a.size, mimeType: a.mimeType,
});
export function acceptAttachments(existing: Attachment[], candidates: Attachment[]) {
  const accepted = [...existing];
  const errors: string[] = [];
  for (const file of candidates) {
    const reason = attachmentError(file) || (accepted.length >= 4 ? 'Máximo de 4 imágenes por publicación.' : '');
    if (reason) errors.push(`${file.name}: ${reason}`);
    else accepted.push(metadata(file));
  }
  return { accepted, errors };
}

// Date and time share validation because Santiago has nonexistent local times.
export function validateField(draft: Draft, state: State, key: keyof Draft, previous: Errors): Errors {
  const next = { ...previous };
  const validated = validateDraft(draft, state);
  const keys: (keyof Draft)[] = key === 'day' || key === 'time' ? ['day', 'time'] : [key];
  for (const field of keys) {
    delete next[field];
    if (validated[field]) next[field] = validated[field];
  }
  return next;
}
export function removeAttachment(draft: Draft, id: string): Draft {
  return { ...draft, attachments: draft.attachments.filter(item => item.id !== id) };
}
