import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button } from '../../components/ui';
import { APP_NAME } from '../../lib/config';
import { RECOVERY_ROUTES, recoveryScreen } from '../../platform/routes';
import { CONFIRMATION_MESSAGE, RECOVERY_TITLES, SIMULATION_NOTE, SUCCESS_MESSAGE, requestRecovery, validatePasswords } from './recoveryPresentation';

export function RecoveryPage() {
  const screen = recoveryScreen(useLocation().pathname) ?? 'request';
  const main = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    document.title = `${RECOVERY_TITLES[screen]} · ${APP_NAME}`;
    main.current?.focus({ preventScroll: true });
  }, [screen]);
  return <main ref={main} tabIndex={-1} className="invitation-page recovery-page">
    <section className="platform-card invitation-card" aria-labelledby="recovery-heading">
      <h1 id="recovery-heading">{RECOVERY_TITLES[screen]}</h1>
      <p className="notice">{SIMULATION_NOTE}</p>
      {screen === 'request' ? <RecoveryRequest /> : screen === 'sent' ? <RecoverySent /> : <RecoveryReset />}
    </section>
  </main>;
}

function RecoveryRequest() {
  const email = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  useEffect(() => { email.current?.focus(); }, []);
  return <form noValidate onSubmit={event => {
    event.preventDefault();
    const result = requestRecovery(email.current?.value ?? '');
    setError(result.error);
    if (result.error) email.current?.focus();
    else navigate(RECOVERY_ROUTES.sent);
  }}>
    <label htmlFor="recovery-email">Correo electrónico</label>
    <input ref={email} id="recovery-email" type="email" autoComplete="email" aria-invalid={!!error} aria-describedby={error ? 'recovery-email-error' : undefined} />
    {error && <p id="recovery-email-error" role="alert">{error}</p>}
    <Button type="submit" className="primary">Enviar instrucciones</Button>
    <Link className="recovery-link" to="/">Volver a iniciar sesión</Link>
  </form>;
}

function RecoverySent() {
  return <>
    <p role="status" aria-live="polite">{CONFIRMATION_MESSAGE}</p>
    <Link className="recovery-link" to="/">Volver a iniciar sesión</Link>
    <p>En un sistema real, el enlace de restablecimiento llegaría por correo.</p>
    <Link className="recovery-link" to={RECOVERY_ROUTES.reset}>Abrir pantalla de restablecimiento (solo demostración)</Link>
  </>;
}

function RecoveryReset() {
  const password = useRef<HTMLInputElement>(null), repeated = useRef<HTMLInputElement>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const [errors, setErrors] = useState({ password: '', repeated: '' });
  const [success, setSuccess] = useState(false);
  useEffect(() => {
    const first = password.current, second = repeated.current;
    return () => {
      if (first) first.value = '';
      if (second) second.value = '';
    };
  }, []);
  useEffect(() => { if (success) message.current?.focus(); }, [success]);
  if (success) return <>
    <p ref={message} tabIndex={-1} role="status" aria-live="polite">{SUCCESS_MESSAGE}</p>
    <Link className="recovery-link" to="/">Volver a iniciar sesión</Link>
  </>;
  return <form noValidate autoComplete="off" onSubmit={event => {
    event.preventDefault();
    const first = password.current, second = repeated.current;
    if (!first || !second) return;
    const result = validatePasswords(first.value, second.value);
    setErrors(result);
    if (result.password) { first.focus(); return; }
    if (result.repeated) { second.focus(); return; }
    first.value = '';
    second.value = '';
    setSuccess(true);
  }}>
    <label htmlFor="recovery-password">Nueva contraseña</label>
    <input ref={password} id="recovery-password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} aria-describedby={errors.password ? 'recovery-password-error' : undefined} />
    {errors.password && <p id="recovery-password-error" role="alert">{errors.password}</p>}
    <label htmlFor="recovery-repeated">Repetir contraseña</label>
    <input ref={repeated} id="recovery-repeated" type="password" autoComplete="new-password" aria-invalid={!!errors.repeated} aria-describedby={errors.repeated ? 'recovery-repeated-error' : undefined} />
    {errors.repeated && <p id="recovery-repeated-error" role="alert">{errors.repeated}</p>}
    <Button type="submit" className="primary">Restablecer contraseña (simulación)</Button>
    <Link className="recovery-link" to="/">Volver a iniciar sesión</Link>
  </form>;
}
