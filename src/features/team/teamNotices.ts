// Avisos de la sesión: navegar fuera de Equipo no los descarta.
interface Notice { id: string; organizationId: string; text: string }
let notices: Notice[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const teamNotices = {
  getSnapshot: () => notices,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  add: (organizationId: string, text: string) => { notices = [...notices, { id: crypto.randomUUID(), organizationId, text }]; notify(); },
  dismiss: (id: string) => { notices = notices.filter(n => n.id !== id); notify(); },
};
