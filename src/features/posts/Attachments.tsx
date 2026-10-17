import type { Attachment } from '../../types';
import { Button } from '../../components/ui';

import { attachmentFiles, mountAttachmentPreview } from './attachmentFiles';
export function Attachments({ items, onRemove }: {
  items: Attachment[]; onRemove?: (id: string) => void;
}) {
  return <ul className="attachments">{items.map(item => <li key={item.id}>
    {attachmentFiles.has(item.id)
      ? <img alt={item.name} ref={element => {
          if (!element) return;
          const file = attachmentFiles.get(item.id);
          if (!file) return;
          return mountAttachmentPreview(element, file);
        }} />
      : <p>Vista previa no disponible tras recargar</p>}
    <span>{item.name} · {Math.ceil(item.size / 1024)} KB · {item.mimeType}</span>
    {onRemove && <Button type="button" onClick={() => onRemove(item.id)}
      aria-label={`Quitar ${item.name}`}>Quitar</Button>}
  </li>)}</ul>;
}
