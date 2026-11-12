export const normalizerRejected = [
  ...[['tab', 'A\tB'], ['lf', 'A\nB'], ['cr', 'A\rB'], ['nul', 'A\0B'], ['zwj', 'A\u200dB'],
    ['bidi-lrm', 'A\u200eB'], ['bidi-rlo', 'A\u202eB'], ['surrogate', 'A\ud800B'],
    ['one', 'A'], ['81', 'A'.repeat(81)]].map(([id, input]) => ({ id, input, field: 'name' as const,
    expected: 'normalizer' as const, reason: 'Control, formato, UTF-16 inválido o longitud fuera de 2–80' })),
  { id: 'expanded-key', input: 'ﷺ'.repeat(5), field: 'organizationName' as const,
    expected: 'normalizer' as const, reason: 'NFKD expande la clave a más de 80 puntos de código' },
];
export const checkRejected = [
  { id: 'double-space', column: 'name', input: 'Acme  Team', constraint: 'CK_organizations_name' },
  { id: 'leading', column: 'name', input: ' Acme', constraint: 'CK_organizations_name' },
  { id: 'trailing', column: 'name', input: 'Acme ', constraint: 'CK_organizations_name' },
  { id: 'tab', column: 'name', input: 'Acme\tTeam', constraint: 'CK_organizations_name' },
  { id: 'key-uppercase', column: 'name_key', input: 'ACME', constraint: 'CK_organizations_name_key' },
  { id: 'key-trailing', column: 'name_key', input: 'acme ', constraint: 'CK_organizations_name_key' },
  { id: 'email-uppercase', column: 'email', input: 'UP@agenda-b2b.test', constraint: 'CK_users_email' },
  { id: 'email-space', column: 'email', input: 'a b@agenda-b2b.test', constraint: 'CK_users_email' },
  { id: 'hash', column: 'password_hash', input: 'invalid', constraint: 'CK_users_password_hash' },
].map(c => ({ ...c, expected: '23514', reason: 'Valor SQL directo no normalizado viola el CHECK indicado' }));
/** Clase 4: rechazados por el tipo de columna, antes de evaluar los CHECK. */
export const columnTypeRejected = [
  { id: 'name-81', column: 'name', input: 'A'.repeat(81), limit: 80 },
  { id: 'name-key-81', column: 'name_key', input: 'a'.repeat(81), limit: 80 },
  { id: 'email-121', column: 'email', input: `${'a'.repeat(64)}@${'b'.repeat(51)}.test`, limit: 120 },
].map(c => ({ ...c, expected: '22001', reason:
  `El varchar(${c.limit}) rechaza antes que CK char_length; el CHECK de longitud máxima es defensa en profundidad inalcanzable por estas columnas` }));
export const collisions = [
  ['cafe', 'Café', 'CAFE'], ['nandu', 'Ñandú', 'Nandu'], ['wide', 'Ａｃｍｅ', 'Acme'],
  ['ligature', 'ﬁsh', 'Fish'], ['turkish', 'İstanbul', 'Istanbul'], ['sigma', 'ΑΣ', 'Ας'],
].map(([id, first, second]) => ({ id, first, second, expected: 'collision', reason: 'Claves plegadas iguales; 23505, nunca 23514' }));
export const distinct = [
  ['german', 'Straße', 'STRASSE'], ['sigma', 'ΑΣ', 'Ασ'], ['dotless', 'ıstanbul', 'istanbul'],
].map(([id, first, second]) => ({ id, first, second, expected: 'distinct', reason: 'El plegado real conserva claves distintas' }));
export const accepted = [
  ['latin', 'Árbol Café'], ['greek', 'Αθήνα'], ['cyrillic', 'Москва'], ['turkish', 'İstanbul'],
  ['german', 'Straße'], ['ligature', 'ﬁsh'], ['wide', 'Ａｃｍｅ'], ['cjk', '東京'],
  ['emoji', '😀🚀'], ['combining', 'Cafe\u0301'], ['two', 'Ab'], ['80', 'a'.repeat(80)],
  ['80-n', 'ñ'.repeat(80)], ['80-emoji', '😀'.repeat(80)],
].map(([id, input]) => ({ id, input, expected: 'accepted', reason: 'Equivalencia pendiente con lower/btrim/cntrl/char_length de PostgreSQL' }));
