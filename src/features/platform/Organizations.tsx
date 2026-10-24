import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CheckCircle2, CirclePause } from 'lucide-react';
import { Button } from '../../components/ui';
import { platformStore } from '../../platform/store';
import { workspaceDirectory } from '../../platform/directory';
import { useStore } from '../../store';
import { pluralize } from '../../lib/pluralize';
import { preferredScrollBehavior } from '../../lib/scroll';
import { OrganizationForm } from './OrganizationForm';
import { CREATION_INVITATION_NOTICE, createdOrganizationVisibility, organizationQueryString, organizationResults, organizationRows, parseOrganizationQuery,
  type OrganizationQuery, type OrganizationRow } from './organizationRows';

function OrganizationStatus({ row }: { row: OrganizationRow }) {
  const active = row.status === 'active', Icon = active ? CheckCircle2 : CirclePause;
  return <span className={`organization-status ${row.status}`}><Icon size={16} aria-hidden="true" />{active ? 'Activa' : 'Suspendida'}</span>;
}
function Managers({ row }: { row: OrganizationRow }) {
  return <>{row.managers.length ? row.managers.map((manager, index) => <div key={index} className="organization-manager">
    {manager.name}{manager.invitationSimulated && <span className="platform-label">Invitación simulada</span>}
  </div>) : 'Sin community manager registrado'}</>;
}
function Emails({ row }: { row: OrganizationRow }) {
  return <>{row.managers.length ? row.managers.map((manager, index) => <div key={index}>{manager.email ?? 'Sin correo registrado'}</div>) : 'Sin correo registrado'}</>;
}
function Name({ row, fresh }: { row: OrganizationRow; fresh: boolean }) {
  return <><strong tabIndex={-1} data-organization-heading>{row.name}</strong>{row.isExample && <span className="platform-label">Datos de ejemplo</span>}{fresh && <span className="platform-label">Nueva</span>}</>;
}
export function Organizations() {
  const workspace = workspaceDirectory(useStore());
  const state = useSyncExternalStore(platformStore.subscribe, platformStore.getState);
  const warning = useSyncExternalStore(platformStore.subscribe, platformStore.getStorageWarning);
  const [params, setParams] = useSearchParams();
  const query = parseOrganizationQuery(params.toString());
  const canonical = organizationQueryString(query);
  // Controlled URL updates preserve spaces while typing; matching always uses the sanitized query.
  const searchText = params.get('q') ?? '';
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ row: OrganizationRow } | null>(null);
  const result = platformStore.listOrganizations(workspace);
  const rows = organizationRows(result.ok ? result.value : [], state, workspace);
  const filtered = organizationResults(rows, query);
  // Sanitize initial URLs and browser navigation without trimming the active input on each keystroke.
  useEffect(() => {
    if (document.activeElement !== search.current && params.toString() !== canonical) setParams(canonical, { replace: true });
  }, [params, canonical, setParams]);
  const visibility = createdOrganizationVisibility(success?.row.id ?? null, rows, query);
  function showCreated() {
    const heading = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-organization-id]') ?? [])
      .find(item => item.dataset.organizationId === success?.row.id && item.getClientRects().length)
      ?.querySelector<HTMLElement>('[data-organization-heading]');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'nearest', behavior: preferredScrollBehavior() });
  }
  function update(next: OrganizationQuery, raw = false) {
    const value = new URLSearchParams(organizationQueryString(next));
    if (raw && next.q) value.set('q', next.q);
    setParams(value, { replace: true });
  }
  function clear() { update({ q: '', estado: 'todas' }); search.current?.focus(); }
  function close() {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  const hasFilters = !!query.q || query.estado !== 'todas';
  return <div className="platform-home organizations-page">
    <h1>Organizaciones</h1>
    <div className="organization-toolbar">
      <label>Buscar organizaciones<input ref={search} type="search" value={searchText} placeholder="Organización, community manager o correo"
        onChange={event => update({ ...query, q: event.target.value }, true)}
        onBlur={() => { if (params.toString() !== canonical) setParams(canonical, { replace: true }); }} /></label>
      {searchText && <Button onClick={() => { update({ ...query, q: '' }); search.current?.focus(); }}>Limpiar búsqueda</Button>}
      <button ref={trigger} className="button primary new-organization" onClick={() => { setFresh(null); setOpen(true); }}>Nueva organización</button>
    </div>
    <div className="organization-filters" role="group" aria-label="Filtrar organizaciones por estado">
      {(['todas', 'activas', 'suspendidas'] as const).map(status => <Button key={status} aria-pressed={query.estado === status}
        onClick={() => update({ ...query, estado: status })}>{ { todas: 'Todas', activas: 'Activas', suspendidas: 'Suspendidas' }[status]} ({filtered.counts[status]})</Button>)}
    </div>
    <p aria-live="polite" aria-atomic="true">{filtered.rows.length ? pluralize(filtered.rows.length, 'organización', 'organizaciones') : 'Ninguna organización coincide'}</p>
    {success && <div className="notice organization-success" role="status" aria-live="polite">
      <p className="creation-title">Organización «{success.row.name}» creada.</p>
      <p className="creation-invitation">{CREATION_INVITATION_NOTICE}</p>
      {visibility === 'hidden' && <><p>Se creó correctamente, pero no coincide con la búsqueda o el filtro actual.</p><Button onClick={clear}>Limpiar búsqueda y filtros</Button></>}
      {visibility === 'visible' && <Button onClick={showCreated}>Ver en la lista</Button>}
      <Button onClick={() => { setSuccess(null); setFresh(null); }}>Entendido</Button>
    </div>}
    {warning && <p role="alert" className="notice">{warning}</p>}
    {!result.ok && <p role="alert">{result.reason}</p>}
    {result.ok && !rows.length ? <section className="platform-card"><h2>Aún no hay organizaciones</h2><Button onClick={() => setOpen(true)}>Nueva organización</Button></section>
      : !filtered.rows.length ? <section className="platform-card"><h2>Ninguna organización coincide con la búsqueda o el filtro actual</h2>{hasFilters && <Button onClick={clear}>Limpiar búsqueda y filtros</Button>}</section>
      : <div ref={list}>
        <table className="organization-table"><caption className="visually-hidden">Organizaciones y sus community managers</caption>
          <thead><tr>{['Organización', 'Community manager', 'Correo', 'Estado'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{filtered.rows.map(row => <tr key={row.id} data-organization-id={row.id}>
            <th scope="row"><Name row={row} fresh={fresh === row.id} /></th><td><Managers row={row} /></td><td><Emails row={row} /></td><td><OrganizationStatus row={row} /><Link className="button" aria-label={`Ver detalle de ${row.name}`} to={`/plataforma/organizaciones/${row.id}${canonical ? `?${canonical}` : ''}`}>Ver detalle</Link></td>
          </tr>)}</tbody>
        </table>
        <div className="organization-cards">{filtered.rows.map(row => <article className="platform-card" key={row.id} data-organization-id={row.id}>
          <dl><dt>Organización</dt><dd><Name row={row} fresh={fresh === row.id} /></dd><dt>Community manager</dt><dd><Managers row={row} /></dd><dt>Correo</dt><dd><Emails row={row} /></dd><dt>Estado</dt><dd><OrganizationStatus row={row} /></dd></dl><Link className="button" aria-label={`Ver detalle de ${row.name}`} to={`/plataforma/organizaciones/${row.id}${canonical ? `?${canonical}` : ''}`}>Ver detalle</Link>
        </article>)}</div>
      </div>}
    {open && <OrganizationForm workspace={workspace} onClose={close} onSaved={next => {
      const organization = next.organizations.at(-1)!;
      const row = organizationRows([organization], next, workspace)[0];
      setSuccess({ row });
      setFresh(row.id);
    }} />}
  </div>;
}
