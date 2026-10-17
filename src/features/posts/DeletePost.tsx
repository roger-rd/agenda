import { useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { actions } from '../../store';
export function DeletePost({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  return <>
    <Button type="button" onClick={() => setOpen(true)}>Eliminar publicación</Button>
    {open && <Modal title="Eliminar publicación" onClose={() => setOpen(false)} initialFocus=".cancel-delete">
      <p>Se eliminarán esta publicación y todos sus comentarios. Esta acción no se puede deshacer.</p>
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions">
        <Button className="cancel-delete" onClick={() => setOpen(false)}>Cancelar</Button>
        <Button className="primary" onClick={() => {
          const result = actions.deletePost(id);
          if (result.ok) onDeleted(); else setError(result.reason);
        }}>Eliminar</Button>
      </div>
    </Modal>}
  </>;
}
