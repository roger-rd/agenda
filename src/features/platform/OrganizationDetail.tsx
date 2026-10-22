import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router';
import { CheckCircle2, CirclePause } from 'lucide-react';
import { Button } from '../../components/ui';
import { APP_NAME } from '../../lib/config';
import { platformStore } from '../../platform/store';
import { workspaceDirectory } from '../../platform/directory';
import { accessCauses, accessCauseLabel } from '../../platform/access';
import { SIMULATED_INVITATION_NOTICE } from '../../platform/validation';
import { useStore } from '../../store';
import { AccessConfirmation, type AccessAction } from './AccessConfirmation';
import { formatOrganizationDate, individuallySuspendedCount, memberConfirmation, organizationConfirmation, organizationsReturnUrl, WORKSPACE_BLOCKING_NOTICE } from './detailLogic';

function AccessBadge({ active, children }: { active: boolean; children: React.ReactNode }) {
  const Icon = active ? CheckCircle2 : CirclePause;
  return <span className={`organization-status ${active ? 'active' : 'suspended'}`}><Icon size={16} aria-hidden="true" />{children}</span>;
}
const roles = { community_manager: 'Community manager', worker: 'Trabajador', client: 'Cliente' };
export function OrganizationDetail({ id }: { id: string }) {
  const workspace = workspaceDirectory(useStore());
  const state = useSyncExternalStore(platformStore.subscribe, platformStore.getState);
  const warning = useSyncExternalStore(platformStore.subscribe, platformStore.getStorageWarning);
  const { search } = useLocation();
  const result = platformStore.viewOrganization(id, workspace);
  const detail = result.ok ? result.value : null;
  const [action, setAction] = useState<AccessAction | null>(null);
  const [message, setMessage] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const name = detail?.organization.name;
  const found = !!detail;
  useEffect(() => { heading.current?.focus(); }, [id, found]);
  useEffect(() => {
    document.title = `${name ?? 'Organización no encontrada'} · Organizaciones · Administración · ${APP_NAME}`;
  }, [name, search]);
  function close() {
    setAction(null);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected && opener.current.getClientRects().length) opener.current.focus({ preventScroll: true });
      else {
        const equivalent = Array.from(document.querySelectorAll<HTMLElement>('[data-access-target]'))
          .find(button => button.dataset.accessTarget === opener.current?.dataset.accessTarget && button.getClientRects().length);
        (equivalent ?? heading.current)?.focus({ preventScroll: true });
      }
    });
  }
  function open(next: AccessAction, target: HTMLElement) { opener.current = target; setAction(next); }
  const back = <Link className="button" to={organizationsReturnUrl(search)}>Volver a organizaciones</Link>;
  const notices = <>{warning && <p className="notice" role="alert">{warning}</p>}{message && <div className="notice" role="status"><p>{message}</p><Button onClick={() => setMessage('')}>Entendido</Button></div>}</>;
  if (!detail) return <div className="platform-home">{back}<h1 ref={heading} tabIndex={-1}>Organización no encontrada</h1>{notices}</div>;
  const { organization, directory } = detail;
  const active = organization.status === 'active';
  const suspended = individuallySuspendedCount(state, id, directory.members.map(m => m.userId));
  const example = !organization.workspaceLinked && state.members.some(m => m.organizationId === id && m.example);
  const invited = state.members.some(m => m.organizationId === id && m.invitation?.simulated);
  function memberFields(member: typeof directory.members[number]) {
    const causes = accessCauses(state, id, member.userId);
    const access = state.memberAccess.find(a => a.organizationId === id && a.userId === member.userId);
    return {
      email: 'email' in member && typeof member.email === 'string' ? member.email : 'Sin correo registrado',
      own: <><AccessBadge active={!causes.memberSuspended}>{causes.memberSuspended ? 'Acceso suspendido' : 'Activo'}</AccessBadge>
        {access?.suspension?.reason && <p>Motivo (solo visible para el administrador): {access.suspension.reason}</p>}</>,
      effective: <><AccessBadge active={causes.allowed}>{causes.allowed ? 'Permitido' : 'Bloqueado'}</AccessBadge>{!causes.allowed && <p>{accessCauseLabel(causes)}</p>}</>,
      button: <Button data-access-target={member.userId} aria-label={`${causes.memberSuspended ? 'Reactivar' : 'Suspender'} acceso de ${member.name}`}
        onClick={event => open({ userId: member.userId, name: member.name, suspend: !causes.memberSuspended }, event.currentTarget)}>{causes.memberSuspended ? 'Reactivar acceso' : 'Suspender acceso'}</Button>,
    };
  }
  return <div className="platform-home organization-detail">
    {back}
    <header><h1 ref={heading} tabIndex={-1}>{organization.name}</h1><AccessBadge active={active}>{active ? 'Activa' : 'Suspendida'}</AccessBadge>
      {example && <span className="platform-label">Datos de ejemplo</span>}{invited && <span className="platform-label">Invitación simulada</span>}
      <div><Button data-access-target="organization" aria-label={`${active ? 'Suspender' : 'Reactivar'} organización ${organization.name}`}
        onClick={event => open({ name: organization.name, suspend: active }, event.currentTarget)}>{active ? 'Suspender organización' : 'Reactivar organización'}</Button></div>
      <p className="notice" role="note">{WORKSPACE_BLOCKING_NOTICE}</p>
    </header>
    {notices}
    <section className="platform-card"><h2>Resumen</h2><dl className="detail-summary">
      <dt>Fecha de creación</dt><dd>{formatOrganizationDate(organization.createdAt)}</dd>
      <dt>Empresas</dt><dd>{directory.companies.length}</dd><dt>Miembros</dt><dd>{directory.members.length}</dd>
      <dt>Acceso individual activo</dt><dd>{directory.members.length - suspended}</dd><dt>Acceso individual suspendido</dt><dd>{suspended}</dd>
      <dt>Estado de la organización</dt><dd>{active ? 'Activa' : 'Suspendida'}</dd>
      {organization.suspension && <><dt>Suspendida desde</dt><dd>{formatOrganizationDate(organization.suspension.at)}</dd>
        {organization.suspension.reason && <><dt>Motivo (solo visible para el administrador)</dt><dd>{organization.suspension.reason}</dd></>}</>}
    </dl>{invited && !directory.companies.length && <p className="notice">{SIMULATED_INVITATION_NOTICE}</p>}</section>
    <section className="platform-card"><h2>Empresas</h2>{directory.companies.length ? <ul className="detail-companies">{directory.companies.map(company => <li key={company.id}>
      <span className="company-color-sample" style={{ backgroundColor: company.color }} aria-hidden="true" />{company.name}
      {state.companies.some(c => c.id === company.id && c.example) && <span className="platform-label">Datos de ejemplo</span>}
    </li>)}</ul> : <p>Esta organización todavía no tiene empresas</p>}</section>
    <section><h2>Miembros</h2>{!directory.members.length ? <p>Esta organización todavía no tiene miembros</p> : <>
      <table className="organization-table member-table"><caption className="visually-hidden">Miembros y acceso efectivo</caption>
        <thead><tr>{['Nombre', 'Correo', 'Rol', 'Estado propio', 'Acceso efectivo', 'Acciones'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{directory.members.map(member => { const fields = memberFields(member); return <tr key={member.userId}><th scope="row">{member.name}</th><td>{fields.email}</td><td>{roles[member.role]}</td><td>{fields.own}</td><td>{fields.effective}</td><td>{fields.button}</td></tr>; })}</tbody>
      </table>
      <div className="organization-cards">{directory.members.map(member => { const fields = memberFields(member); return <article className="platform-card" key={member.userId}><h3>{member.name}</h3>
        <dl><dt>Correo</dt><dd>{fields.email}</dd><dt>Rol</dt><dd>{roles[member.role]}</dd><dt>Estado propio</dt><dd>{fields.own}</dd><dt>Acceso efectivo</dt><dd>{fields.effective}</dd></dl>{fields.button}</article>; })}</div>
    </>}</section>
    {action && <AccessConfirmation organizationId={id} action={action} onClose={close}
      description={action.userId ? memberConfirmation(action.name, organization.name, action.suspend, !active) : organizationConfirmation(organization.name, action.suspend, directory.members.length, suspended)}
      onResult={outcome => {
        if (outcome.ok) setMessage(`${action.userId ? `Acceso de «${action.name}» ${action.suspend ? 'suspendido' : 'reactivado'}` : `Organización «${action.name}» ${action.suspend ? 'suspendida' : 'reactivada'}`}. Los datos ya guardados se conservan.`);
        else if (outcome.code === 'no_change') setMessage(`Ya estaba ${action.suspend ? 'suspendido' : 'activo'} el ${action.userId ? 'acceso individual' : 'acceso de la organización'}.`);
        else if (outcome.code === 'no_admin_session') setMessage('La sesión de administrador terminó. Vuelve a iniciar la simulación.');
        else setMessage(action.userId ? 'El miembro ya no existe en esta organización.' : 'Organización no encontrada.');
        close();
      }} />}
  </div>;
}
