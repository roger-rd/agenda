'use strict';
const { MIN_SECRET_BYTES } = require('./constants.cjs');
const { HarnessError } = require('./harness-error.cjs');
const { secretVariants } = require('./secret-variants.cjs');
const MARK = Buffer.from('[REDACTED]');

/** Aho-Corasick por bytes. Las transiciones completas dan coste O(n).
 * Solo hace falta la coincidencia más larga: todas terminan en el mismo byte.
 * @param {readonly string[]} secrets */
function buildDfa(secrets) {
  if (!Array.isArray(secrets) || secrets.length === 0) throw new HarnessError('H-RDX-EMPTY');
  if (secrets.some(secret => typeof secret !== 'string' || Buffer.byteLength(secret) < MIN_SECRET_BYTES)) throw new HarnessError('H-RDX-SHORT');
  if (secrets.length > 16 || secrets.some(secret => Buffer.byteLength(secret) > 128)) throw new HarnessError('H-RDX-4');
  /** @type {{next:Int32Array, fail:number, depth:number, longest:number, children:number}[]} */
  const nodes = [{ next: new Int32Array(256).fill(-1), fail: 0, depth: 0, longest: 0, children: 0 }];
  let maxLength = 0;
  for (const secret of secrets) for (const pattern of secretVariants(secret)) {
    maxLength = Math.max(maxLength, pattern.length);
    let state = 0;
    for (const byte of pattern) {
      if (nodes[state].next[byte] === -1) {
        if (nodes.length >= 20000) throw new HarnessError('H-RDX-4');
        nodes[state].next[byte] = nodes.length;
        nodes[state].children++;
        nodes.push({ next: new Int32Array(256).fill(-1), fail: 0, depth: nodes[state].depth + 1, longest: 0, children: 0 });
      }
      state = nodes[state].next[byte];
    }
    nodes[state].longest = Math.max(nodes[state].longest, pattern.length);
  }
  const queue = new Int32Array(nodes.length);
  let head = 0; let tail = 0;
  for (let byte = 0; byte < 256; byte++) {
    const child = nodes[0].next[byte];
    if (child < 0) nodes[0].next[byte] = 0;
    else queue[tail++] = child;
  }
  const partial = new Int32Array(nodes.length);
  while (head < tail) {
    const index = queue[head++];
    const node = nodes[index];
    node.longest = Math.max(node.longest, nodes[node.fail].longest);
    partial[index] = node.children ? node.depth : partial[node.fail];
    for (let byte = 0; byte < 256; byte++) {
      const child = node.next[byte];
      if (child < 0) node.next[byte] = nodes[node.fail].next[byte];
      else { nodes[child].fail = nodes[node.fail].next[byte]; queue[tail++] = child; }
    }
  }
  return { nodes, partial, maxLength };
}

class Redactor {
  /** @param {readonly string[]} secrets */
  constructor(secrets) {
    this.dfa = buildDfa(secrets);
    this.state = 0;
    this.position = 0;
    this.start = 0;
    this.window = Buffer.alloc(this.dfa.maxLength + 1);
    /** @type {{start:number, end:number}|null} */
    this.interval = null;
    this.finished = false;
    this.maxRetainedBytes = 0;
  }
  get retainedBytes() { return this.position - this.start; }
  /** @param {Uint8Array} chunk @returns {Buffer} */
  push(chunk) {
    if (this.finished || !(chunk instanceof Uint8Array)) throw new HarnessError('H-RDX-4');
    const result = Buffer.allocUnsafe(chunk.length * 3 + this.window.length * 3 + MARK.length);
    let used = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      this.window[this.position % this.window.length] = byte;
      this.position++;
      this.state = this.dfa.nodes[this.state].next[byte];
      const length = this.dfa.nodes[this.state].longest;
      if (length) {
        const begin = this.position - length;
        if (this.interval) { if (begin < this.interval.start) this.interval.start = begin; this.interval.end = this.position; }
        else this.interval = { start: begin, end: this.position };
      }
      const partialStart = this.position - this.dfa.partial[this.state];
      if (this.interval && partialStart > this.interval.end) {
        while (this.start < this.interval.start) result[used++] = this.window[this.start++ % this.window.length];
        if (this.start < this.interval.end) this.start = this.interval.end;
        MARK.copy(result, used); used += MARK.length;
        this.interval = null;
      }
      const limit = this.interval && this.interval.start < partialStart ? this.interval.start : partialStart;
      while (this.start < limit) result[used++] = this.window[this.start++ % this.window.length];
      // Descarta los bytes ya cubiertos, incluso en intervalos solapados infinitos.
      // El marcador se emite solo al cerrar el intervalo, conservando adyacencia.
      if (this.interval && this.start >= this.interval.start && this.start < this.interval.end) this.start = this.interval.end;
      if (this.retainedBytes > this.maxRetainedBytes) this.maxRetainedBytes = this.retainedBytes;
    }
    return result.subarray(0, used);
  }
  /** D-C7B-2: un sufijo parcial nunca sale crudo. @returns {Buffer} */
  finish() {
    if (this.finished) return Buffer.alloc(0);
    this.finished = true;
    // Si un prefijo más largo sigue abierto antes de una coincidencia, también
    // pertenece a la cola incierta: se suprime como una sola región al finalizar.
    const count = this.interval ? 1 + (this.position > this.interval.end ? 1 : 0) : (this.retainedBytes ? 1 : 0);
    this.start = this.position;
    this.interval = null;
    return Buffer.concat(Array.from({ length: count }, () => MARK));
  }
}

/** Detección incremental, sin retener el contenido analizado.
 * @param {readonly string[]} secrets */
function createMatcher(secrets) {
  const dfa = buildDfa(secrets);
  let state = 0;
  return Object.freeze({
    /** @param {Uint8Array} chunk @returns {boolean} */
    feed(chunk) {
      let hit = false;
      for (const byte of chunk) { state = dfa.nodes[state].next[byte]; if (dfa.nodes[state].longest) hit = true; }
      return hit;
    },
  });
}
module.exports = Object.freeze({ Redactor, createMatcher });
