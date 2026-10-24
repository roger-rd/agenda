import { useId } from 'react';
import { actions, useStore } from '../../store';
import { selectDemoGroups, selectUser } from '../../store/selectors';
export function DemoMode({ onChange }: { onChange: (userId: string) => void }) {
  const id = useId(), state = useStore();
  return <div className="demo-mode">
    <label htmlFor={id}>Probar como {selectUser(state).name}</label>
    <select id={id} value={state.activeUserId} aria-describedby={id + '-help'} onChange={e => onChange(e.target.value)}>
      {selectDemoGroups(state, actions.memberSuspended).map(group => <optgroup key={group.role} label={group.label}>
        {group.people.map(person => <option key={person.id} value={person.id}>{person.label}</option>)}
      </optgroup>)}
    </select>
    <p id={id + '-help'}>Esta demostración funciona solo en este navegador y origen: no se envía ningún correo ni hay conexión entre dispositivos. Los permisos y la visibilidad reales se comprobarán en el servidor.</p>
  </div>;
}
