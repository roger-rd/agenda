import { Link } from 'react-router';
import { PLATFORM_ROUTES } from '../../platform/routes';
export function PlatformNotFound() {
  return <div className="platform-home"><h1>404 · Página no encontrada</h1>
    <p>Esta página no existe en el panel de plataforma.</p>
    <div><Link className="button" to={PLATFORM_ROUTES.home}>Volver al panel</Link></div>
  </div>;
}
