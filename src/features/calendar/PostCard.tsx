import { Eye, EyeOff } from 'lucide-react';
import { FormatBadge, StatusBadge } from '../../components/ui';
import { zonedFormat } from '../../lib/dates';
import type { Post } from '../../types';
export function PostCard({ post, responsible, expanded = false, onOpen }: {
  post: Post; responsible?: string; expanded?: boolean; onOpen: (id: string) => void;
}) {
  const visibility = post.visible_para_cliente ? 'Visible para el cliente' : 'Solo equipo';
  return <button className={`post-card ${expanded ? 'expanded' : ''}`} onClick={() => onOpen(post.id)}>
    <div className="post-time">
      <span>{zonedFormat(post.scheduledAt, expanded ? 'dd/MM · HH:mm' : 'HH:mm')}</span>
      <span aria-label={visibility} title={visibility}>{post.visible_para_cliente ? <Eye size={13} /> : <EyeOff size={13} />}</span>
    </div>
    <strong>{post.title}</strong>
    {expanded && <>
      <span className="responsible">{responsible}</span>
      <span className="visibility">{visibility}</span>
    </>}
    <div className="post-meta">
      <FormatBadge format={post.format} />
      <StatusBadge status={post.status} />
    </div>
  </button>;
}
