import { useNavigate } from 'react-router';
import { LogOut, RotateCcw } from 'lucide-react';
import { actions, useStore } from '../../store';
import { selectUser } from '../../store/selectors';
import { can } from '../../store/permissions';
import { Avatar } from '../../components/ui';
import { DemoMode } from './DemoMode';
export function ProfileMenu({ onReset, onNavigate }: { onReset: () => void; onNavigate: () => void }) {
  const s = useStore();
  const user = selectUser(s);
  const navigate = useNavigate();
  return <div className="sidebar-bottom">
    <DemoMode role={s.role} onChange={role => { onNavigate(); actions.setRole(role); navigate('/'); }} />{can(s.role, 'resetDemo') && <button className="reset" onClick={onReset}>
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
