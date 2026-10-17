import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { actions, useStore } from '../../store';
import { selectAssignableUsers } from '../../store/selectors';
import { can } from '../../store/permissions';
import { statuses } from '../../store/transitions';
import { zonedFormat } from '../../lib/dates';
import type { Post } from '../../types';
import { acceptAttachments, formats, toInput, validateDraft, validateField, removeAttachment, type Draft, type Errors } from './validation';
import { Attachments } from './Attachments';
import { attachmentFiles } from './attachmentFiles';
import { DeletePost } from './DeletePost';

export function PostForm({ companyId, day, post, onClose, onDeleted, onSaved }: {
  companyId: string; day: string; post?: Post; onClose: () => void; onDeleted?: () => void; onSaved?: (post: Post) => void;
}) {
  const state = useStore();
  const [initial] = useState<Draft>(() => ({
    companyId, title: post?.title ?? '', description: post?.description ?? '',
    day: post ? zonedFormat(post.scheduledAt, 'yyyy-MM-dd') : day,
    time: post ? zonedFormat(post.scheduledAt, 'HH:mm') : '10:00',
    format: post?.format ?? 'Post', status: post?.status ?? 'Pendiente',
    responsibleId: post?.responsibleId ?? selectAssignableUsers(state, companyId)[0]?.id ?? '',
    visible_para_cliente: post?.visible_para_cliente ?? false,
    instagramUrl: post?.instagramUrl ?? '', attachments: post?.attachments ?? [],
  }));
  const [draft, setDraft] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState('');
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const saved = useRef(false);
  const owned = useRef(new Set<string>());
  useEffect(() => {
    const ids = owned.current;
    return () => {
      for (const id of ids) {
        if (!saved.current) attachmentFiles.delete(id);
      }
    };
  }, []);
  function close() {
    if (JSON.stringify(draft) !== JSON.stringify(initial)) setConfirm(true);
    else onClose();
  }
  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    const next = { ...draft, [key]: value };
    setDraft(next);
    setMessage('');
    if (attempted) setErrors(validateField(next, state, key, errors));
  }
  function field(key: keyof Draft) {
    return { onBlur: () => { if (attempted) setErrors(validateField(draft, state, key, errors)); }, id: `post-${key}`, 'aria-invalid': !!errors[key],
      'aria-describedby': errors[key] ? `error-${key}` : undefined };
  }
  function error(key: keyof Draft) {
    return errors[key] && <span className="field-error" id={`error-${key}`}>{errors[key]}</span>;
  }
  return <Modal title={post ? 'Editar publicación' : 'Nueva publicación'} side
    onClose={close} initialFocus="#post-title">
    <form ref={form} noValidate onSubmit={event => {
      event.preventDefault();
      setAttempted(true);
      setMessage('');
      const next = validateDraft(draft, state);
      setErrors(next);
      if (Object.keys(next).length) {
        form.current?.querySelector<HTMLElement>(`#post-${Object.keys(next)[0]}`)?.focus();
        return;
      }
      const result = post ? actions.updatePost(post.id, toInput(draft)) : actions.createPost(toInput(draft));
      if (result.ok) {
        saved.current = true;
        for (const item of initial.attachments) {
          if (!draft.attachments.some(a => a.id === item.id)) attachmentFiles.delete(item.id);
        }
        onSaved?.(post ? result.state.posts.find(item => item.id === post.id)! : result.state.posts.at(-1)!);
        onClose();
      } else setMessage(result.reason);
    }}>
      {Object.keys(errors).length > 0 && <p role="alert" className="field-error">Revisa los campos indicados antes de guardar.</p>}
      {message && <p role="alert" className="field-error">{message}</p>}
      <label>Título *<input {...field('title')} maxLength={120} required value={draft.title}
        onChange={e => change('title', e.target.value)} />{error('title')}</label>
      <label>Descripción<textarea rows={4} value={draft.description}
        onChange={e => change('description', e.target.value)} /></label>
      <div className="form-grid">
        <label>Formato<select {...field('format')} value={draft.format}
          onChange={e => change('format', e.target.value as Draft['format'])}>
          {formats.map(format => <option key={format}>{format}</option>)}
        </select>{error('format')}</label>
        <label>Estado<select {...field('status')} value={draft.status}
          onChange={e => change('status', e.target.value as Draft['status'])}>
          {statuses.map(status => <option key={status}>{status}</option>)}
        </select>{error('status')}</label>
        <label>Fecha prevista<input {...field('day')} type="date" required value={draft.day}
          onChange={e => change('day', e.target.value)} />{error('day')}</label>
        <label>Hora prevista (Santiago)<input {...field('time')} type="time" required value={draft.time}
          onChange={e => change('time', e.target.value)} />{error('time')}</label>
      </div>
      <label>Responsable<select {...field('responsibleId')} value={draft.responsibleId}
        onChange={e => change('responsibleId', e.target.value)}>
        <option value="">Selecciona un responsable</option>
        {selectAssignableUsers(state, companyId).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>{error('responsibleId')}</label>
      <label className="switch-label"><input type="checkbox" role="switch"
        checked={draft.visible_para_cliente} onChange={e => change('visible_para_cliente', e.target.checked)} />
        Visible para el cliente</label>
      <label>Enlace a Instagram (opcional)<input {...field('instagramUrl')} type="url"
        value={draft.instagramUrl} onChange={e => change('instagramUrl', e.target.value)} />{error('instagramUrl')}</label>
      <label>Adjuntos (máximo 4 imágenes de 5 MB)<input {...field('attachments')} type="file"
        accept="image/*" multiple onChange={e => {
          const files = Array.from(e.target.files ?? []);
          const candidates = files.map(file => ({ id: crypto.randomUUID(), name: file.name,
            size: file.size, mimeType: file.type }));
          const result = acceptAttachments(draft.attachments, candidates);
          candidates.forEach((candidate, index) => {
            if (!result.accepted.some(a => a.id === candidate.id)) return;
            attachmentFiles.set(candidate.id, files[index]);
            owned.current.add(candidate.id);
          });
          change('attachments', result.accepted);
          setFileErrors(result.errors);
          e.target.value = '';
        }} />{error('attachments')}</label>
      <p>Demostración local: las imágenes no se suben ni persisten tras recargar</p>
      <div aria-live="polite">{fileErrors.map((text, i) => <p className="field-error" key={i}>{text}</p>)}</div>
      <Attachments items={draft.attachments} onRemove={id => {
        if (owned.current.has(id)) attachmentFiles.delete(id);
        owned.current.delete(id);
        change('attachments', removeAttachment(draft, id).attachments);
        setFileErrors(['Adjunto quitado.']);
      }} />
      <div className="modal-actions">
        <Button type="button" onClick={close}>Cancelar</Button>
        <Button className="primary" type="submit">Guardar publicación</Button>
      </div>
    </form>
    {post && can(state.role, 'deletePost') && <DeletePost id={post.id} onDeleted={onDeleted ?? onClose} />}
    {confirm && <Modal title="Descartar cambios sin guardar" onClose={() => setConfirm(false)}
      initialFocus=".keep-editing">
      <p>Hay cambios sin guardar. ¿Quieres descartarlos?</p>
      <div className="modal-actions">
        <Button className="keep-editing" onClick={() => setConfirm(false)}>Seguir editando</Button>
        <Button onClick={onClose}>Descartar cambios</Button>
      </div>
    </Modal>}
  </Modal>;
}
