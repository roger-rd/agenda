import { Link, useMatch, useNavigate } from 'react-router';
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
  const profileActive = !!useMatch('/perfil');
  return <div className="sidebar-bottom">
    <DemoMode onChange={userId => { onNavigate(); actions.setActiveUser(userId); navigate('/'); }} />{can(s.role, 'resetDemo') && <button className="reset" onClick={onReset}>
      <RotateCcw size={13} />Restablecer datos de demostración</button>}<div className="user">
      <Link className="profile-link" to="/perfil" aria-label={`Mi perfil, ${user.name}`} aria-current={profileActive ? 'page' : undefined} onClick={onNavigate}>
      <Avatar name={user.name} />
      <div>
        <strong>{user.name}</strong>
        <small>{{ community_manager: 'Community manager', worker: 'Trabajador', client: 'Cliente' }[user.role]}{user.example ? ' · datos de ejemplo' : ''}</small>
      </div>
      </Link>
      <button aria-label="Salir de la demostración" onClick={() => { onNavigate(); actions.logout(); }}>
        <LogOut size={17} />
      </button>
    </div>
  </div>;
}
