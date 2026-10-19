import type { PostStatus } from '../../types';
import type { viewportMode } from '../../lib/responsive';

export const statusPresentation = (mode: ReturnType<typeof viewportMode>) => mode === 'desktop' ? 'menu' : 'sheet';
export const statusAnnouncement = (title: string, status: PostStatus) => `«${title}» ahora está en ${status}`;
