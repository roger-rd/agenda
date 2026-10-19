import { useNavigate } from 'react-router';
import { LogOut, RotateCcw } from 'lucide-react';
import { actions, useStore } from '../../store';
import { selectUser } from '../../store/selectors';
import { can } from '../../store/permissions';
import { Avatar } from '../../components/ui';
import type { Role } from '../../types';
export function ProfileMenu({ onReset, onNavigate }: { onReset: () => void; onNavigate: () => void }) {
  const s = useStore();
  const user = selectUser(s);
  const navigate = useNavigate();
  return <div className="sidebar-bottom">
    <div className="demo-mode">
      <label htmlFor="demo-role">Modo de demostración</label>
      <select id="demo-role" value={s.role} onChange={e => { onNavigate(); actions.setRole(e.target.value as Role); navigate('/'); }}>
        <option value="community_manager">Community manager</option>
        <option value="worker">Trabajador</option>
        <option value="client">Cliente</option>
      </select>
      <p>Demostración local. Los permisos y la visibilidad reales se comprobarán en el servidor.</p>
    </div>{can(s.role, 'resetDemo') && <button className="reset" onClick={onReset}>
      <RotateCcw size={13} />Restablecer datos de demostración</button>}<div className="user">
      <Avatar name={user.name} />
      <div>
        <strong>{user.name}</strong>
        <small>{user.example ? 'Trabajador · datos de ejemplo' : s.role === 'client' ? 'Cliente' : 'Community manager'}</small>
      </div>
      <button aria-label="Salir de la demostración" onClick={() => { onNavigate(); actions.logout(); }}>
        <LogOut size={17} />
      </button>
    </div>
  </div>;
}
