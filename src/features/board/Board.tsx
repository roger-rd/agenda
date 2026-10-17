import { useStore } from '../../store';
import { can } from '../../store/permissions';
import { statuses } from '../../store/transitions';
import { StatusBadge } from '../../components/ui';
import { Eye, EyeOff } from 'lucide-react';
import { FormatBadge } from '../../components/ui';
import { zonedFormat } from '../../lib/dates';
import { pluralize } from '../../lib/pluralize';
import type { ViewProps } from '../calendar/viewTypes';
import { StatusControl } from './StatusControl';
export function Board({ posts, users, onOpen }: ViewProps) {
  const state = useStore();
  if (!can(state.role, 'changeStatus')) return null;
  return <div className="board-grid">{statuses.map(status => {
    const column = posts.filter(p => p.status === status);
    return <section className="board-column" key={status} aria-label={status}>
      <header>
        <StatusBadge status={status} />
        <span>{pluralize(column.length, 'publicación', 'publicaciones')}</span>
      </header>
      <div className="column-scroll">{column.map(post => <article className="board-card" key={post.id}>
        <button className="board-open" onClick={() => onOpen(post.id)}>
          <span className="post-time"><span>{zonedFormat(post.scheduledAt, 'dd/MM · HH:mm')}</span><span aria-label={post.visible_para_cliente ? 'Visible para el cliente' : 'Solo equipo'} title={post.visible_para_cliente ? 'Visible para el cliente' : 'Solo equipo'}>{post.visible_para_cliente ? <Eye size={13} /> : <EyeOff size={13} />}</span></span>
          <strong>{post.title}</strong>
          <span className="responsible">{users.find(u => u.id === post.responsibleId)?.name}</span>
        </button>
        <div className="board-meta"><FormatBadge format={post.format} />
        <StatusControl post={post} /></div>
      </article>)}{!column.length && <p className="column-empty">Sin publicaciones</p>}</div>
    </section>;
  })}</div>;
}
