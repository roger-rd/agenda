import { useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { actions, useStore } from '../../store';
import { can } from '../../store/permissions';
import { selectComments } from '../../store/selectors';
import { zonedFormat } from '../../lib/dates';
const roles = { community_manager: 'Community manager', worker: 'Trabajador', client: 'Cliente' };
export function Comments({ postId, onDirtyChange }: { postId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const state = useStore();
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  return <section className="comments" aria-label="Comentarios">
    <h3>Comentarios</h3>
    <p>Los comentarios se comparten con el cliente cuando la publicación es visible.</p>
    <ol>{selectComments(state, postId).map(comment => {
      const author = state.users.find(u => u.id === comment.authorId);
      return <li key={comment.id}>
        <strong>{author?.name} · {author && roles[author.role]}</strong>
        <time dateTime={comment.createdAt}>{zonedFormat(comment.createdAt, 'dd/MM/yyyy HH:mm')} (Santiago)</time>
        <p>{comment.body}</p>
      </li>;
    })}</ol>
    {can(state.role, 'comment') && <form noValidate onSubmit={event => {
      event.preventDefault();
      const result = actions.addComment(postId, body);
      if (result.ok) { setBody(''); setError(''); onDirtyChange?.(false); }
      else { setError(result.reason); input.current?.focus(); }
    }}>
      <label>Añadir comentario<textarea ref={input} rows={3} maxLength={2000} required
        value={body} onChange={e => { setBody(e.target.value); setError(''); onDirtyChange?.(!!e.target.value); }} aria-invalid={!!error}
        aria-describedby={error ? 'comment-error' : undefined} /></label>
      {error && <p id="comment-error" role="alert" className="field-error">{error}</p>}
      <Button type="submit">Añadir comentario</Button>
    </form>}
  </section>;
}
