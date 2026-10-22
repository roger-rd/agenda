import { useId } from 'react';
import type { Role } from '../../types';
export function DemoMode({ role, onChange }: { role: Role; onChange: (role: Role) => void }) {
  const id = useId();
  return <div className="demo-mode">
    <label htmlFor={id}>Modo de demostración</label>
    <select id={id} value={role} onChange={e => onChange(e.target.value as Role)}>
      <option value="community_manager">Community manager</option>
      <option value="worker">Trabajador</option>
      <option value="client">Cliente</option>
    </select>
    <p>Demostración local. El selector cambia el usuario simulado y sus permisos; cada usuario tiene su propio acceso individual. Los permisos y la visibilidad reales se comprobarán en el servidor.</p>
  </div>;
}
