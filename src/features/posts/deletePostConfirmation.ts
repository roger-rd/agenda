/** Conserva el título completo; React lo renderiza como texto. */
export function formatDeletePostConfirmation(title: string): string {
  return `Se eliminará «${title.trim() ? title : 'Publicación sin título'}» y todos sus comentarios. Esta acción no se puede deshacer.`;
}
