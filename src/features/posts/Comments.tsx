import { useLayoutEffect, useRef, useState } from 'react';
import { preferredScrollBehavior } from '../../lib/scroll';
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
  const list = useRef<HTMLOListElement>(null);
  const added = useRef(false);
  useLayoutEffect(() => {
    if (!added.current) return;
    added.current = false;
    input.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      list.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: preferredScrollBehavior() });
    });
    return () => cancelAnimationFrame(frame);
  });
  return <section className="comments" aria-label="Comentarios">
    <h3>Comentarios</h3>
    <p>Los comentarios se comparten con el cliente cuando la publicación es visible.</p>
    <ol ref={list}>{selectComments(state, postId).map(comment => {
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
      if (result.ok) { added.current = true; setBody(''); setError(''); onDirtyChange?.(false); }
      else { setError(result.reason); input.current?.focus(); }
    }}>
      <label>Comentario<textarea ref={input} rows={3} maxLength={2000} required
        value={body} onChange={e => { setBody(e.target.value); setError(''); onDirtyChange?.(!!e.target.value); }} aria-invalid={!!error}
        aria-describedby={error ? 'comment-error' : undefined} /></label>
      <span className="comment-limit">{body.length}/2000 caracteres</span>
      {error && <p id="comment-error" role="alert" className="field-error">{error}</p>}
      <Button type="submit" aria-label="Enviar comentario">Enviar comentario</Button>
    </form>}
  </section>;
}
