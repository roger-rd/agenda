import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { selectCompanies, selectPosts, selectPost, selectCounts, selectFilteredPosts, selectResponsibleUsers } from '../src/store/selectors';
import { can } from '../src/store/permissions';
import { zonedFormat } from '../src/lib/dates';
test('cliente: aislamiento en empresas, detalle, filtros, responsables y contadores', () => { const s = { ...generateDemo(), role: 'client' as const }; assert.deepEqual(selectCompanies(s).map(c => c.id), ['company-0']); assert.equal(selectPosts(s, 'company-1').length, 0); const visible = selectPosts(s, 'company-0'); assert.ok(visible.length > 0); assert.ok(visible.every(p => p.visible_para_cliente)); for (const p of s.posts.filter(p => !p.visible_para_cliente || p.companyId !== 'company-0'))
    assert.equal(selectPost(s, p.id), undefined); assert.deepEqual(selectFilteredPosts(s, 'company-0', { status: '', format: '', responsible: '' }).map(p => p.id).sort(), visible.map(p => p.id).sort()); assert.equal(selectCounts(s, 'company-0').planned, visible.filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM') === zonedFormat(new Date(), 'yyyy-MM')).length); assert.equal(selectCounts(s, 'company-0').pending, visible.filter(p => ['Pendiente', 'En proceso'].includes(p.status)).length); assert.ok(selectResponsibleUsers(s, 'company-0').every(u => visible.some(p => p.responsibleId === u.id))); });
test('trabajador: únicamente empresas asignadas y sin gestión', () => { const s = { ...generateDemo(), role: 'worker' as const }; assert.deepEqual(selectCompanies(s).map(c => c.id), ['company-0', 'company-1']); assert.equal(can(s.role, 'createCompany'), false); assert.equal(selectPosts(s, 'company-2').length, 0); });
test('community manager: separación de empresas y confirmaciones', () => { const s = generateDemo(); assert.equal(selectCompanies(s).length, 4); assert.ok(can(s.role, 'createCompany')); for (const c of s.companies)
    assert.ok(selectPosts(s, c.id).every(p => p.companyId === c.id)); assert.ok(s.posts.filter(p => p.status === 'Subido').every(p => p.confirmadoEn && p.confirmadoPor)); });
