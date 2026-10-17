import type { Post } from '../../types';
import { useState } from 'react';
import { PostForm } from '../posts/PostForm';
import { DeletePost } from '../posts/DeletePost';
import { Attachments } from '../posts/Attachments';
import { Comments } from '../posts/Comments';
import { can } from '../../store/permissions';
import { Button, FormatBadge, Modal } from '../../components/ui';
import { zonedFormat } from '../../lib/dates';
import { useStore } from '../../store';
import { selectPost } from '../../store/selectors';
import { StatusControl } from '../board/StatusControl';
export function PostDetail({ id, companyId, onClose, onSaved }: { id: string; companyId: string; onClose: () => void; onSaved?: (post: Post) => void }) {
  const [dirtyComment, setDirtyComment] = useState(false);
  const [confirm, setConfirm] = useState(false);
  function close() { if (dirtyComment) setConfirm(true); else onClose(); }
  const [editing, setEditing] = useState(false);
  const state = useStore();
  const selected = selectPost(state, id);
  const post = selected?.companyId === companyId ? selected : undefined;
  return <Modal title={post ? 'Detalle de la publicación' : 'Publicación no disponible'} onClose={close}>
    {post ? <>
      <div className="detail-badges">
        <StatusControl post={post} />
        <FormatBadge format={post.format} />
      </div>
      <h3>{post.title}</h3>
      <p>{post.description}</p>
      <dl>
        <dt>Fecha y hora</dt>
        <dd>{zonedFormat(post.scheduledAt, "d 'de' MMMM yyyy · HH:mm")} (Santiago)</dd>
        <dt>Responsable</dt>
        <dd>{state.users.find(u => u.id === post.responsibleId)?.name}</dd>
        <dt>Visibilidad</dt>
        <dd>{post.visible_para_cliente ? 'Visible para el cliente y el equipo' : 'Solo equipo'}</dd>
        {post.confirmadoEn && <>
          <dt>Publicación confirmada</dt>
          <dd>{state.users.find(u => u.id === post.confirmadoPor)?.name} · {zonedFormat(post.confirmadoEn, 'dd/MM/yyyy HH:mm')}</dd>
        </>}
      </dl>
      {post.instagramUrl && <p><a href={post.instagramUrl} target="_blank" rel="noreferrer">Ver en Instagram</a></p>}
      <Attachments items={post.attachments} />
      <div className="modal-actions">
        {can(state.role, 'editPost') && <Button onClick={() => setEditing(true)}>Editar</Button>}
        {can(state.role, 'deletePost') && <DeletePost id={post.id} onDeleted={onClose} />}
      </div>
      <Comments postId={post.id} onDirtyChange={setDirtyComment} />
      {editing && <PostForm companyId={companyId} day="" post={post} onSaved={onSaved}
        onClose={() => setEditing(false)} onDeleted={onClose} />}
    </> : <>
      <p>Esta publicación no existe o no está disponible para tu perfil.</p>
      <Button onClick={onClose}>Cerrar</Button>
    </>}
    {confirm && <Modal title="Descartar comentario sin guardar" onClose={() => setConfirm(false)} initialFocus=".keep-comment">
      <p>Hay un comentario sin guardar. ¿Quieres descartarlo?</p>
      <div className="modal-actions"><Button className="keep-comment" onClick={() => setConfirm(false)}>Seguir escribiendo</Button>
        <Button onClick={onClose}>Descartar comentario</Button></div>
    </Modal>}
  </Modal>;
}
