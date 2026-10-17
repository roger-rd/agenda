import { useStore } from './store';
import { Login } from './features/auth/Login';
import { Workspace } from './features/workspace/Workspace';

export function App() {
    const state = useStore();
    return state.authenticated ? <Workspace key={state.role} /> : <Login />;
}
