import { enterPlatformAdmin } from '../../auth/sessions';
import { useNavigate } from 'react-router';
import { CalendarDays, ArrowRight } from 'lucide-react';
import { actions } from '../../store';
import { APP_NAME } from '../../lib/config';
import { Button } from '../../components/ui';

export function Login() {
  const navigate = useNavigate();
  return <main className="login" tabIndex={-1}>
    <section className="login-story">
      <div className="brand"><CalendarDays />{APP_NAME}</div>
      <div>
        <span className="eyebrow">MENOS CAOS. MÁS IDEAS.</span>
        <h1>Tu contenido,<br />en su mejor momento.</h1>
        <p>Un espacio para organizar tus marcas y dar claridad a cada publicación.</p>
        <div className="sample">
          <span>Todo empieza con una buena idea</span>
          <div><span className="status status-Completado">● Completado</span><span>Lista para conectar.</span></div>
        </div>
      </div>
      <small>Planifica con intención. Crea con tranquilidad.</small>
    </section>
    <section className="login-form">
      <div className="brand login-brand"><CalendarDays aria-hidden="true" />{APP_NAME}</div>
      <span className="eyebrow">TU ESPACIO DE TRABAJO</span>
      <h2>Bienvenido de nuevo</h2>
      <p>Conoce una forma más clara de planificar.</p>
      <form noValidate autoComplete="off" onSubmit={e => {
        e.preventDefault();
        actions.login();
        navigate('/empresas');
      }}>
        <label>Correo electrónico
          <input type="email" inputMode="email" autoCapitalize="none" spellCheck={false}
            autoComplete="off" placeholder="tu@correo.com" />
        </label>
        <label>Contraseña
          <input type="password" autoComplete="off" placeholder="Escribe una contraseña" />
        </label>
        <Button className="primary">Entrar a la demostración <ArrowRight size={17} /></Button>
        <Button type="button" className="admin-entry" aria-describedby="admin-entry-note"
          onClick={() => { enterPlatformAdmin(); navigate('/plataforma'); }}>
          Entrar como administrador de la plataforma (simulación)
        </Button>
        <p id="admin-entry-note" className="admin-entry-note">Simulación: no hay autenticación real y no se pide contraseña. El administrador no accede al contenido de las empresas.</p>
      </form>
      <div className="notice">
        Entrarás como <strong>Edison Valera</strong>, community manager. Autenticación de demostración local.
        Los permisos y la visibilidad reales deberán comprobarse en el servidor.
        Los campos son de ejemplo: no se validan ni se guardan. No uses credenciales reales.
      </div>
    </section>
  </main>;
}
