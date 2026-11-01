'use strict';

/** Lista finita: UTF-8, JSON (dos niveles), JS, escapes Unicode JSON,
 * cuatro alfabetos porcentuales (ambas cajas), form-urlencoded con +,
 * y núcleos base64/base64url en tres alineaciones. No cubre UTF-16,
 * compresión, cifrado ni composiciones arbitrarias de codificaciones.
 * @param {string} secret @returns {Buffer[]} */
function secretVariants(secret) {
  const values = new Set();
  /** @param {string} value */
  const add = value => { if (Buffer.byteLength(value) >= 6) values.add(value); };
  const bytes = Buffer.from(secret, 'utf8');
  add(secret);
  const json = JSON.stringify(secret).slice(1, -1);
  add(json);
  add(JSON.stringify(json).slice(1, -1));
  const escaped = secret.replace(/\\/g, '\\\\');
  add(escaped);
  add(escaped.replace(/'/g, "\\'"));
  for (const upper of [false, true]) {
    /** @param {number} value */
    const hex = value => '\\u' + (upper ? value.toString(16).toUpperCase() : value.toString(16)).padStart(4, '0');
    add(Array.from(json, character => {
      const point = /** @type {number} */ (character.codePointAt(0));
      if (point < 128) return character;
      return point <= 0xffff ? hex(point) : hex(0xd800 + ((point - 0x10000) >> 10)) + hex(0xdc00 + ((point - 0x10000) & 0x3ff));
    }).join(''));
  }
  const alphabets = ["A-Za-z0-9\\-._!~*'()", 'A-Za-z0-9\\-._~', 'A-Za-z0-9*\\-._', "A-Za-z0-9\\-_.!~*'();/?:@&=+$,#"];
  for (const alphabet of alphabets) {
    const allowed = new RegExp('[' + alphabet + ']');
    const encoded = Array.from(bytes, byte => byte < 128 && allowed.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : '%' + byte.toString(16).toUpperCase().padStart(2, '0')).join('');
    add(encoded);
    add(encoded.replace(/%[0-9A-F]{2}/g, value => value.toLowerCase()));
    // Ampliación aditiva aprobada: URLSearchParams convierte espacios en +.
    if (alphabet === 'A-Za-z0-9*\\-._' && secret.includes(' ')) {
      add(encoded.replace(/%20/g, '+'));
      add(encoded.replace(/%20/g, '+').replace(/%[0-9A-F]{2}/g, value => value.toLowerCase()));
    }
  }
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    let encoded = padded.toString('base64').replace(/=+$/, '');
    if (padded.length % 3 !== 0) encoded = encoded.slice(0, -1);
    encoded = encoded.slice(Math.ceil(offset * 8 / 6));
    add(encoded);
    add(encoded.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return Array.from(values, value => Buffer.from(value, 'utf8'));
}
module.exports = Object.freeze({ secretVariants });
