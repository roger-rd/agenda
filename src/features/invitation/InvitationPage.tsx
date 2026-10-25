import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '../../components/ui';
import { actions, useStore } from '../../store';
import { useActiveSession } from '../../auth/useActiveSession';
import { logoutAll } from '../../auth/sessions';
import { invitationCode } from '../../platform/routes';
import type { WorkspaceError } from '../../store/operations';
import type { InvitationInspection } from '../../store/invitations';
import { acceptanceErrors, acceptanceFields, acceptanceSubmitState, invitationMessages } from './invitationPresentation';

export function InvitationPage() {
  const state = useStore(), session = useActiveSession();
  const code = invitationCode(useLocation().pathname), navigate = useNavigate();
  const [draft, setDraft] = useState({ name: '', email: '' });
  const [attempt, setAttempt] = useState(0);
  const submitted = attempt > 0;
  const [message, setMessage] = useState('');
  const [errorCode, setErrorCode] = useState<WorkspaceError | null>(null);
  const [ready, setReady] = useState(true);
  const [, tick] = useState(0);
  const [success, setSuccess] = useState<{ id: string; details: Extract<InvitationInspection, { status: 'valid' }> } | null>(null);
  const main = useRef<HTMLElement>(null), alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
    const refresh = () => { actions.refresh(); tick(n => n + 1); };
    refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(() => tick(n => n + 1), 1000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(timer); };
  }, []);
  const inspection = actions.inspectInvitation(code);
  const errors = acceptanceFields(draft.name, draft.email);
  useEffect(() => { alert.current?.focus(); }, [message, attempt]);
  function accept() {
    setAttempt(n => n + 1);
    if (!ready || session !== 'none' || inspection.status !== 'valid') return;
    setMessage('');
    if (Object.values(errors).some(Boolean)) { setErrorCode('invalid_input'); return; }
    const result = actions.acceptInvitation(code, draft);
    if (!result.ok) {
      setErrorCode(result.code ?? 'invalid_input');
      setMessage(acceptanceErrors[result.code ?? 'invalid_input'] ?? 'No se pudo aceptar la invitación.');
      setReady(actions.refresh());
      alert.current?.focus();
      return;
    }
    const id = result.state.invitations.find(i => i.code === code)!.usedBy!;
    setSuccess({ id, details: inspection });
    setErrorCode(null);
    setMessage('');
  }
  function enter() {
    if (!success) return;
    const result = actions.enterAs(success.id);
    if (result.ok) navigate('/');
    else { setMessage(acceptanceErrors[result.code ?? 'invalid_input'] ?? 'No se pudo entrar.'); actions.refresh(); }
  }
  const acceptedName = state.users.find(u => u.id === success?.id)?.name ?? 'Persona no disponible';
  const submit = acceptanceSubmitState(errorCode, ready);
  const details = success?.details ?? (inspection.status === 'valid' ? inspection : null);
  return <main ref={main} tabIndex={-1} className="invitation-page" data-revision={state.revision}>
    <section className="platform-card invitation-card" aria-labelledby="invitation-heading">
      <h1 id="invitation-heading">{success ? `Bienvenido/a, ${acceptedName}` : inspection.status === 'valid' ? 'Aceptar invitación' : invitationMessages[inspection.status]}</h1>
      {message && <p ref={alert} tabIndex={-1} role="alert" aria-live="assertive">{message}</p>}
      {details && <dl className="invitation-summary"><div><dt>Organización</dt><dd><strong>{details.organization}</strong></dd></div><div><dt>Rol</dt><dd>{details.role === 'worker' ? 'Trabajador' : 'Cliente'}</dd></div><div><dt>Empresas</dt><dd>{details.companies.join(', ')}</dd></div></dl>}
      {success ? <div role="status" aria-live="polite"><p>Tu acceso está preparado. Entra cuando quieras continuar.</p><Button className="primary" onClick={enter}>Entrar como {acceptedName}</Button></div>
        : inspection.status === 'valid' && (session !== 'none'
          ? <div><p>Para aceptar esta invitación primero cierra tu sesión actual</p><Button onClick={logoutAll}>Cerrar sesión y continuar</Button></div>
          : <form noValidate onSubmit={e => { e.preventDefault(); accept(); }}>
            {submitted && Object.values(errors).some(Boolean) && <p ref={message ? undefined : alert} tabIndex={-1} role="alert">Revisa los campos indicados.</p>}
            <label htmlFor="invitation-name">Nombre</label>
            <input id="invitation-name" autoComplete="name" required maxLength={120} value={draft.name} aria-invalid={submitted && !!errors.name} aria-describedby="invitation-name-error" onChange={e => setDraft({ ...draft, name: e.target.value })} />
            <span id="invitation-name-error">{submitted && errors.name}</span>
            <label htmlFor="invitation-email">Correo</label>
            <input id="invitation-email" type="email" autoComplete="email" required maxLength={120} value={draft.email} aria-invalid={submitted && !!errors.email} aria-describedby="invitation-email-error" onChange={e => setDraft({ ...draft, email: e.target.value })} />
            <span id="invitation-email-error">{submitted && errors.email}</span>
            {!ready && <Button type="button" onClick={() => setReady(actions.refresh())}>Actualizar datos para reintentar</Button>}
            <Button className="primary" type="submit" disabled={submit.disabled}>{submit.label}</Button>
          </form>)}
      <p className="notice">Esta demostración funciona solo en este navegador y origen: no se envía ningún correo ni hay conexión entre dispositivos.</p>
    </section>
  </main>;
}
