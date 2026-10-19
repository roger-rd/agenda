import { useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { actions, useStore } from '../../store';
import { selectPost } from '../../store/selectors';
import { formatDeletePostConfirmation } from './deletePostConfirmation';
export function DeletePost({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const state = useStore();
  const post = selectPost(state, id);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  return <>
    <Button type="button" onClick={() => setOpen(true)}>Eliminar publicación</Button>
    {open && <Modal adaptive className="filters-sheet confirmation-sheet" title="Eliminar publicación" onClose={() => setOpen(false)} initialFocus=".cancel-delete">
      <p>{formatDeletePostConfirmation(post?.title ?? '')}</p>
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions">
        <Button className="cancel-delete" onClick={() => setOpen(false)}>Cancelar</Button>
        <Button className="primary destructive" onClick={() => {
          const result = actions.deletePost(id);
          if (result.ok) onDeleted(); else setError(result.reason);
        }}>Eliminar</Button>
      </div>
    </Modal>}
  </>;
}
