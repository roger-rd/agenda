import { Link, useLocation, useNavigate } from 'react-router';
import { Building2, CalendarDays, LayoutDashboard, Menu, X } from 'lucide-react';
import { useNavigationDrawer } from '../../lib/useNavigationDrawer';
import { APP_NAME } from '../../lib/config';
import { Avatar, Button } from '../../components/ui';
import { logoutAll } from '../../auth/sessions';
import { PLATFORM_ADMIN_NAME } from '../../platform/ids';
import { PLATFORM_NAVIGATION, PLATFORM_ROUTES, isPlatformHome, isOrganizationsRoute, organizationDetailId } from '../../platform/routes';
import { OrganizationDetail } from './OrganizationDetail';
import { Organizations } from './Organizations';
import { PlatformHome } from './PlatformHome';
import { PlatformNotFound } from './PlatformNotFound';

function DemoNotice({ drawer = false }: { drawer?: boolean }) {
  return <div role="note" className={`platform-demo ${drawer ? 'platform-drawer-demo' : ''}`}>
    <span className="platform-demo-full">Simulación de administrador de la plataforma. Sin autenticación real: los datos son de ejemplo y se guardan solo en este navegador.</span>
    <span className="platform-demo-compact">Simulación de administrador · Sin autenticación real.<br />Datos de ejemplo solo en este navegador.</span>
  </div>;
}

export function PlatformShell() {
  const { open, show, close, drawer, background, onKeyDown } = useNavigationDrawer();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const home = isPlatformHome(pathname);
  return <div className="app-shell platform-shell">
    {open && <div className="drawer-overlay" aria-hidden="true" onClick={close} />}
    <aside id="platform-navigation" ref={drawer} tabIndex={-1}
      className={`sidebar platform-sidebar ${open ? 'drawer-open' : ''}`}
      role={open ? 'dialog' : undefined} aria-modal={open ? true : undefined}
      aria-label={open ? 'Menú de administración de plataforma' : undefined} onKeyDown={onKeyDown}>
      <Button className="drawer-close" aria-label="Cerrar menú" onClick={close}><X size={20} />Cerrar menú</Button>
      <Link className="brand" to={PLATFORM_ROUTES.home} onClick={close}>
        <span className="brand-mark"><CalendarDays size={22} /></span><span>{APP_NAME}</span>
      </Link>
      <p className="platform-section-label">Administración de plataforma</p>
      <span className="platform-label">Administrador</span>
      <DemoNotice drawer />
      <nav aria-label="Administración de plataforma">
        {PLATFORM_NAVIGATION.map(item => <Link key={item.href} to={item.href} onClick={close} aria-current={pathname === item.href || pathname === `${item.href}/` || item.href === PLATFORM_ROUTES.organizations && !!organizationDetailId(pathname) ? 'page' : undefined}>
          {item.href === PLATFORM_ROUTES.home ? <LayoutDashboard size={18} aria-hidden="true" /> : <Building2 size={18} aria-hidden="true" />}{item.label}
        </Link>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="user"><Avatar name={PLATFORM_ADMIN_NAME} /><div>
          <strong>{PLATFORM_ADMIN_NAME}</strong><small>Administrador de la plataforma (simulación)</small>
        </div></div>
        <Button onClick={() => { close(); logoutAll(); navigate('/'); }}>Salir de la simulación</Button>
      </div>
    </aside>
    <div className="main-column" ref={background}>
      <header className="platform-header">
        <Button className="menu-trigger" aria-label="Abrir menú" aria-expanded={open} aria-controls="platform-navigation" onClick={show}><Menu size={22} /></Button>
        <strong>Administración de plataforma</strong>
      </header>
      <DemoNotice />
      <main className="main-content" tabIndex={-1}>{home ? <PlatformHome /> : isOrganizationsRoute(pathname) ? <Organizations /> : organizationDetailId(pathname) ? <OrganizationDetail key={organizationDetailId(pathname)} id={organizationDetailId(pathname)!} /> : <PlatformNotFound />}</main>
    </div>
  </div>;
}
