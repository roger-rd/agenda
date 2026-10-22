import { Link } from 'react-router';
import { PLATFORM_ROUTES } from '../../platform/routes';
import { useSyncExternalStore } from 'react';
import { Avatar } from '../../components/ui';
import { PLATFORM_ADMIN_NAME } from '../../platform/ids';
import { platformStore } from '../../platform/store';
import { workspaceDirectory } from '../../platform/directory';
import { useStore } from '../../store';
import { pluralize } from '../../lib/pluralize';

export function PlatformHome() {
  const workspace = useStore();
  useSyncExternalStore(platformStore.subscribe, platformStore.getState);
  const result = platformStore.listOrganizations(workspaceDirectory(workspace));
  const organizations = result.ok ? result.value : [];
  const active = organizations.filter(organization => organization.status === 'active').length;
  const suspended = organizations.filter(organization => organization.status === 'suspended').length;
  return <div className="platform-home">
    <div><span className="platform-label">Administrador</span><h1>Panel de plataforma</h1></div>
    <section className="platform-card platform-identity" aria-label="Identidad del administrador">
      <Avatar name={PLATFORM_ADMIN_NAME} />
      <div><h2>{PLATFORM_ADMIN_NAME}</h2><p>Administrador de la plataforma · Simulación</p></div>
    </section>
    <section className="platform-card" aria-labelledby="organization-summary">
      <h2 id="organization-summary">Resumen de organizaciones</h2>
      {result.ok ? <div className="platform-stats" aria-live="polite">
        <p><strong>{pluralize(organizations.length, 'organización', 'organizaciones')}</strong><span>En este navegador</span></p>
        <p><strong>{pluralize(active, 'activa')}</strong><span>Organizaciones activas</span></p>
        <p><strong>{pluralize(suspended, 'suspendida')}</strong><span>Organizaciones suspendidas</span></p>
      </div> : <p role="alert">{result.reason}</p>}
      <Link className="button" to={PLATFORM_ROUTES.organizations}>Ver organizaciones</Link>
    </section>
    <p className="notice">El administrador gestiona organizaciones y accesos, pero no ve publicaciones, comentarios ni datos de contenido de las empresas.</p>
    {platformStore.getStorageWarning() && <p role="alert" className="notice">{platformStore.getStorageWarning()}</p>}
  </div>;
}
