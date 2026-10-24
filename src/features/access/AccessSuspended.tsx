import { useEffect, useRef } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { WorkspaceAccessCauses } from '../../platform/access';
import type { User } from '../../types';
import { leaveWorkspace } from '../../auth/sessions';
import { Button } from '../../components/ui';
import { DemoMode } from '../workspace/DemoMode';
import { ACCESS_CONTACT, ACCESS_SIMULATION, accessMessage } from './accessMessages';
export function AccessSuspended({ causes, user, onUserChange }: {
  causes: WorkspaceAccessCauses; user: User; onUserChange: (userId: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [user.id]);
  const roleName = { community_manager: 'Community manager', worker: 'Trabajador', client: 'Cliente' }[user.role];
  return <main className="access-suspended" tabIndex={-1}>
    <section className="platform-card access-card" aria-labelledby="access-heading">
      <LockKeyhole aria-hidden="true" size={32} />
      <h1 data-access-heading id="access-heading" ref={heading} tabIndex={-1}>Acceso suspendido</h1>
      <p role="alert">{accessMessage(causes)}</p>
      <p>{ACCESS_CONTACT}</p>
      <p>Estás probando como: <strong>{user.name}</strong> ({roleName})</p>
      <DemoMode onChange={onUserChange} />
      <p className="notice">{ACCESS_SIMULATION}</p>
      <Button onClick={leaveWorkspace}>Salir</Button>
    </section>
  </main>;
}
