// solve.js: a faster drop-in for csv-reader 1.0.0.
//
// run(input) returns csv-reader 1.0.0's answer for one case's input {text, header}: the JSON value
// {columns, rows, errors}. main(inputDir, outputDir) answers the harness's whole cases.json into answers.json.
// The reading policy is csv-reader's, to the letter:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped, error stray_cr;
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is one quote) and
//     each CRLF or lone CR inside it reads as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk when the field ends); a quote that never closes is a literal
//     character and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character, and fields stay strings;
//   - columns is the first record when header is true (else null); rows are padded with '' (short_row, with
//     fields) or cut (long_row, with extra) to the first record's width;
//   - each error is {code, line, row}, line the 1-based line its record starts on and row its index in rows
//     (null for the header), pushed in the order met.
//
// Why it is fast.
//   - No string is ever built. cases.json is read as bytes and each case's text is scanned where it sits, still
//     JSON-escaped: JSON escapes exactly the characters a CSV reader cares about (a quote is \" and a line break
//     \n or \r), and a run of escaped bytes is already the JSON text of the value it spells, so every field is
//     copied from input bytes to output bytes.
//   - Little fresh memory. The input is read through one reused 256 KB window and the answers are written from one
//     reused output buffer, flushed between records, so the process never touches megabytes of new pages.
//   - The header flag comes after the text in cases.json, so the first record is written between two reserved
//     gaps of fixed size, filled at the end of the case (padded with JSON whitespace) once the flag is known;
//     errors are kept as numbers and written at the end of the case too.
//   - One scan function walks the whole file, so V8 compiles its hot loop once; the rare paths are small
//     functions of their own, and a tiny warm-up walks every branch before the real input.
//   - Anything that is not the plain JSON.stringify layout the harness writes (a \u escape that spells a quote,
//     comma or line break, other keys, whitespace) is answered by the same reader after JSON.parse and a
//     canonical JSON.stringify of each case, so the answer never depends on how the input was spelled.

import { closeSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** How a field ended: at a comma, at a line break, at the end of the text, or at the end of the window. */
const COMMA = 0;
const BREAK = 1;
const END = 2;
const MORE = 3;

/** Error codes, in the numeric error records. */
const E_STRAY = 0;
const E_JUNK = 1;
const E_UNTERM = 2;
const E_SHORT = 3;
const E_LONG = 4;

const WINDOW = 1 << 18;
const FLUSH = 3 << 16;

/** The input window: S[0, N) holds data and S[N] is a raw quote, the sentinel. I is the read cursor. */
let S = null;
let N = 0;
let I = 0;
let EOF = false;
let SRC_FD = -1;
let SRC_MEM = null;
let SRC_POS = 0;
/** At a record's start at least LOW bytes are in the window unless the source is spent. */
let LOW = 16384;

/** The output buffer, its cursor, the bytes already written to OUT_FD, and when to flush. */
let D = null;
let O = 0;
let FLUSHED = 0;
let OUT_FD = -1;
let FLUSH_AT = 0;

/** The case's errors: 5 ints each (code, line, record index, a, b), and the bytes of long rows' extras. */
let EI = new Int32Array(4096);
let EC = 0;
let XB = Buffer.allocUnsafe(1 << 16);
let XO = 0;
/** The current record's line and index, for the errors it records. */
let RL = 0;
let RK = 0;

/** What the field readers hand back. */
let T_I = 0;
let T_O = 0;
let T_LINE = 0;
let T_END = 0;
/** What the record reader hands back besides: where the width-th field ended, and whether the line was blank. */
let T_CUT = 0;
let T_BLANK = false;

class NonCanonical extends Error {}

const bytes = (s) => Buffer.from(s, 'latin1');
const HEADER_KEY = bytes('","header":');
const ID_KEY = bytes('{"id":"');
const TEXT_KEY = bytes('","input":{"text":"');
const PRE_H = bytes('{"columns":             ');
const PRE_N = bytes('{"columns":null,"rows":[');
const SUF_H = bytes(',"rows":[');
const SUF_N2 = bytes(',        ');
const SUF_N1 = bytes('         ');
const EMPTY_H = bytes('{"columns":[],"rows":[');
const EMPTY_N = bytes('{"columns":null,"rows":[');
const ERRORS_KEY = bytes('],"errors":[');
const CODE_HEAD = ['stray_cr', 'quote_junk', 'unterminated_quote', 'short_row', 'long_row'].map((c) =>
  bytes('{"code":"' + c + '","line":'),
);
const ROW_KEY = bytes(',"row":');
const NULL = bytes('null');
const FIELDS_KEY = bytes(',"fields":');
const EXTRA_KEY = bytes(',"extra":[');

/** The window and the output buffer, with a DataView on each for the 4-byte steps of the field readers. */
let SV = null;
let DV = null;
function setS(t) {
  S = t;
  SV = new DataView(t.buffer, t.byteOffset, t.length);
}
function setD(t) {
  D = t;
  DV = new DataView(t.buffer, t.byteOffset, t.length);
}

/** Refill the window keeping S[keep, N) (moved to the front), doubling it first when `grow`. */
function refill(keep, grow) {
  let s = S;
  const rest = N - keep;
  if (grow) {
    const t = Buffer.allocUnsafe(s.length * 2);
    s.copy(t, 0, keep, N);
    setS(t);
    s = t;
    fitOut(O);
  } else if (keep > 0 && rest > 0) s.copyWithin(0, keep, N);
  let n = rest;
  // 8 bytes past the data stay free: the sentinel, and the field readers' 4-byte reads past it.
  const cap = s.length - 8;
  while (n < cap && !EOF) {
    let got;
    if (SRC_FD >= 0) got = readSync(SRC_FD, s, n, cap - n, null);
    else {
      got = Math.min(cap - n, SRC_MEM.length - SRC_POS);
      SRC_MEM.copy(s, n, SRC_POS, SRC_POS + got);
      SRC_POS += got;
    }
    if (got === 0) EOF = true;
    else n += got;
  }
  N = n;
  s[n] = 34;
  I = 0;
}

/** Keep the output buffer large enough for any record the window can hold past FLUSH_AT. */
function fitOut(o) {
  const need = FLUSH_AT + 3 * S.length + 4096;
  if (D.length < need) {
    const t = Buffer.allocUnsafe(need);
    D.copy(t, 0, 0, o);
    setD(t);
  }
}

function writeAll(b, from, to) {
  while (from < to) from += writeSync(OUT_FD, b, from, to - from);
}

/** Past FLUSH_AT: write the buffer out (file) or let it grow (memory). Returns the new cursor. */
function flushOut(o) {
  if (OUT_FD >= 0) {
    writeAll(D, 0, o);
    FLUSHED += o;
    return 0;
  }
  FLUSH_AT *= 2;
  fitOut(o);
  return o;
}

/** Room for `need` more bytes at `o`. Returns the cursor (0 after a flush). */
function room(o, need) {
  if (o + need > D.length) {
    if (o > 0) o = flushOut(o);
    if (o + need > D.length) {
      const t = Buffer.allocUnsafe(o + need + 4096);
      D.copy(t, 0, 0, o);
      setD(t);
    }
  }
  return o;
}

function addErr(code, a, b) {
  if (EC + 5 > EI.length) {
    const t = new Int32Array(EI.length * 2);
    t.set(EI);
    EI = t;
  }
  EI[EC] = code;
  EI[EC + 1] = RL;
  EI[EC + 2] = RK;
  EI[EC + 3] = a;
  EI[EC + 4] = b;
  EC += 5;
}

const hex = (c) => (c >= 48 && c <= 57 ? c - 48 : (c | 32) >= 97 && (c | 32) <= 102 ? (c | 32) - 87 : -1);

/** A \uXXXX escape at i, copied as it stands; one that spells a character the reader cares about is no plain input. */
function copyU(s, d, i, o) {
  const a = hex(s[i + 2]);
  const b = hex(s[i + 3]);
  const c = hex(s[i + 4]);
  const e = hex(s[i + 5]);
  if ((a | b | c | e) < 0) throw new NonCanonical();
  const v = (a << 12) | (b << 8) | (c << 4) | e;
  if (v === 0x22 || v === 0x2c || v === 0x0a || v === 0x0d) throw new NonCanonical();
  d[o] = 92;
  d[o + 1] = 117;
  d[o + 2] = s[i + 2];
  d[o + 3] = s[i + 3];
  d[o + 4] = s[i + 4];
  d[o + 5] = s[i + 5];
  return o + 6;
}

/**
 * An unquoted field (or its tail, or the junk after a closing quote) at i, written at o. Hands back in T_*.
 * Four bytes a step: each word is stored as it is read, and a word holding a comma, a backslash or a raw quote
 * (found with the zero-byte bit trick on the word XOR each of them; the lowest flagged byte is always a real one)
 * stops the step at that byte; the bytes stored past it are overwritten by what comes next.
 */
function plainFn(s, d, i, o, line, n) {
  const sv = SV;
  const dv = DV;
  for (;;) {
    const w = sv.getInt32(i, true);
    const a = w ^ 0x2c2c2c2c;
    const b = w ^ 0x5c5c5c5c;
    const q = w ^ 0x22222222;
    const m = (((a - 0x01010101) & ~a) | ((b - 0x01010101) & ~b) | ((q - 0x01010101) & ~q)) & 0x80808080;
    dv.setInt32(o, w, true);
    if (m === 0) {
      i += 4;
      o += 4;
      continue;
    }
    const k = (31 - Math.clz32(m & -m)) >> 3;
    i += k;
    o += k;
    const c = s[i];
    if (c === 44) {
      T_I = i + 1;
      T_END = COMMA;
      break;
    }
    if (c === 92) {
      if (i + 6 > n) {
        T_END = MORE;
        return;
      }
      const e = s[i + 1];
      if (e === 110) {
        T_I = i + 2;
        line += 1;
        T_END = BREAK;
        break;
      }
      if (e === 114) {
        if (s[i + 2] === 92 && s[i + 3] === 110) {
          T_I = i + 4;
          line += 1;
          T_END = BREAK;
          break;
        }
        addErr(E_STRAY, 0, 0);
        i += 2;
        continue;
      }
      if (e === 117) {
        o = copyU(s, d, i, o);
        i += 6;
        continue;
      }
      d[o++] = 92;
      d[o++] = e;
      i += 2;
      continue;
    }
    // the raw quote: the end of the case's text, or the sentinel at the end of the window
    T_I = i;
    T_END = i < n ? END : MORE;
    break;
  }
  T_O = o;
  T_LINE = line;
}

/** A field that opens with a quote (\") at i, written at o. Hands back in T_*. Four bytes a step, as plainFn. */
function quotedFn(s, d, i, o, line, n) {
  const sv = SV;
  const dv = DV;
  const openI = i;
  const openLine = line;
  const vs = o;
  i += 2;
  for (;;) {
    const w = sv.getInt32(i, true);
    const b = w ^ 0x5c5c5c5c;
    const q = w ^ 0x22222222;
    const m = (((b - 0x01010101) & ~b) | ((q - 0x01010101) & ~q)) & 0x80808080;
    dv.setInt32(o, w, true);
    if (m === 0) {
      i += 4;
      o += 4;
      continue;
    }
    const k = (31 - Math.clz32(m & -m)) >> 3;
    i += k;
    o += k;
    if (s[i] === 92) {
      if (i + 6 > n) {
        T_END = MORE;
        return;
      }
      const e = s[i + 1];
      if (e === 34) {
        if (s[i + 2] === 92 && s[i + 3] === 34) {
          d[o++] = 92;
          d[o++] = 34;
          i += 4;
          continue;
        }
        i += 2;
        break;
      }
      if (e === 110) {
        d[o++] = 92;
        d[o++] = 110;
        line += 1;
        i += 2;
        continue;
      }
      if (e === 114) {
        d[o++] = 92;
        d[o++] = 110;
        line += 1;
        i += s[i + 2] === 92 && s[i + 3] === 110 ? 4 : 2;
        continue;
      }
      if (e === 117) {
        o = copyU(s, d, i, o);
        i += 6;
        continue;
      }
      d[o++] = 92;
      d[o++] = e;
      i += 2;
      continue;
    }
    // a raw quote
    if (i >= n) {
      T_END = MORE;
      return;
    }
    // The quote never closes: a literal character, and the text after it is read again, unquoted.
    addErr(E_UNTERM, 0, 0);
    o = vs;
    d[o++] = 92;
    d[o++] = 34;
    plainFn(s, d, openI + 2, o, openLine, n);
    return;
  }
  const c = s[i];
  if (c === 44) {
    T_I = i + 1;
    T_END = COMMA;
  } else if (c === 34) {
    T_I = i;
    T_END = END;
  } else if (c === 92 && s[i + 1] === 110) {
    T_I = i + 2;
    line += 1;
    T_END = BREAK;
  } else if (c === 92 && s[i + 1] === 114 && s[i + 2] === 92 && s[i + 3] === 110) {
    T_I = i + 4;
    line += 1;
    T_END = BREAK;
  } else {
    // What follows the closing quote is appended as it stands (quote_junk when any was added).
    plainFn(s, d, i, o, line, n);
    if (T_END !== MORE && T_O > o) addErr(E_JUNK, 0, 0);
    return;
  }
  T_O = o;
  T_LINE = line;
}

/** A short row's padding, at the record's end. */
function padShort(count, width, o) {
  addErr(E_SHORT, count, 0);
  const need = 3 * (width - count) + 16;
  if (o + need > D.length) {
    const t = Buffer.allocUnsafe(o + need + 3 * S.length + 4096);
    D.copy(t, 0, 0, o);
    setD(t);
  }
  const d = D;
  while (count < width) {
    d[o++] = 44;
    d[o++] = 34;
    d[o++] = 34;
    count += 1;
  }
  return o;
}

/** Copy b[from, to) to t at `at`, byte by byte: the pieces are short, and a native copy per piece costs more. */
function cp(b, from, to, t, at) {
  while (from < to) t[at++] = b[from++];
  return at;
}

/** A long row's extra fields, already written at d[from, to), kept for its error record. */
function longRow(d, from, to) {
  const len = to - from;
  if (XO + len > XB.length) {
    const t = Buffer.allocUnsafe((XO + len) * 2);
    XB.copy(t, 0, 0, XO);
    XB = t;
  }
  cp(d, from, to, XB, XO);
  addErr(E_LONG, XO, XO + len);
  XO += len;
}

function ensure(m) {
  if (N - I < m && !EOF) refill(I, false);
}

function match(s, i, key) {
  for (let j = 0; j < key.length; j++) if (s[i + j] !== key[j]) return false;
  return true;
}

function put(o, b) {
  o = room(o, b.length);
  return cp(b, 0, b.length, D, o);
}

function putInt(o, v) {
  const d = D;
  if (v < 0) throw new NonCanonical();
  let len = 1;
  for (let t = v; t >= 10; t = (t / 10) | 0) len += 1;
  for (let j = len - 1; j >= 0; j--) {
    d[o + j] = 48 + (v % 10);
    v = (v / 10) | 0;
  }
  return o + len;
}

/** Fill a reserved gap at file offset `off` (still in the buffer, or already written out). */
function patch(off, b) {
  if (off >= FLUSHED) b.copy(D, off - FLUSHED);
  else {
    let done = 0;
    while (done < b.length) done += writeSync(OUT_FD, b, done, b.length - done, off + done);
  }
}

/**
 * Before a case: the separator or the closing bracket, then {"id":"...","input":{"text":" and the BOM. Leaves I at
 * the text's first character; false at the end of the array.
 */
function beginCase(first) {
  ensure(4096);
  const s = S;
  let i = I;
  if (s[i] === 93 && i < N) {
    O = put(O, bytes(']'));
    I = i + 1;
    return false;
  }
  if (!first) {
    if (s[i] !== 44) throw new NonCanonical();
    i += 1;
    O = put(O, bytes(','));
  }
  if (!match(s, i, ID_KEY)) throw new NonCanonical();
  i += ID_KEY.length;
  while (s[i] !== 34) {
    if (s[i] === 92 || i >= N) throw new NonCanonical();
    i += 1;
  }
  if (!match(s, i, TEXT_KEY)) throw new NonCanonical();
  i += TEXT_KEY.length;
  if (s[i] === 0xef && s[i + 1] === 0xbb && s[i + 2] === 0xbf) i += 3;
  else if (
    s[i] === 92 &&
    s[i + 1] === 117 &&
    (s[i + 2] | 32) === 102 &&
    (s[i + 3] | 32) === 101 &&
    (s[i + 4] | 32) === 102 &&
    (s[i + 5] | 32) === 102
  )
    i += 6;
  if (i > N) throw new NonCanonical();
  I = i;
  return true;
}

/** After a case's text (I at its closing quote): read the header flag, fill the gaps, write the errors. */
function endCase(k, firstOff, endOff) {
  ensure(64);
  const s = S;
  let i = I;
  if (!match(s, i, HEADER_KEY)) throw new NonCanonical();
  i += HEADER_KEY.length;
  let header;
  if (s[i] === 116 && s[i + 1] === 114 && s[i + 2] === 117 && s[i + 3] === 101) {
    header = true;
    i += 4;
  } else if (s[i] === 102 && s[i + 1] === 97 && s[i + 2] === 108 && s[i + 3] === 115 && s[i + 4] === 101) {
    header = false;
    i += 5;
  } else throw new NonCanonical();
  if (s[i] !== 125 || s[i + 1] !== 125 || i + 2 > N) throw new NonCanonical();
  I = i + 2;
  let o = O;
  if (k > 0) {
    patch(firstOff, header ? PRE_H : PRE_N);
    patch(endOff, header ? SUF_H : k > 1 ? SUF_N2 : SUF_N1);
  } else o = put(o, header ? EMPTY_H : EMPTY_N);
  o = put(o, ERRORS_KEY);
  for (let x = 0; x < EC; x += 5) {
    const code = EI[x];
    const extra = code === E_LONG ? EI[x + 4] - EI[x + 3] : 0;
    o = room(o, 128 + extra);
    const d = D;
    if (x > 0) d[o++] = 44;
    const head = CODE_HEAD[code];
    o = cp(head, 0, head.length, d, o);
    o = putInt(o, EI[x + 1]);
    o = cp(ROW_KEY, 0, ROW_KEY.length, d, o);
    const rk = EI[x + 2];
    if (header && rk === 0) o = cp(NULL, 0, 4, d, o);
    else o = putInt(o, header ? rk - 1 : rk);
    if (code === E_SHORT) {
      o = cp(FIELDS_KEY, 0, FIELDS_KEY.length, d, o);
      o = putInt(o, EI[x + 3]);
    } else if (code === E_LONG) {
      o = cp(EXTRA_KEY, 0, EXTRA_KEY.length, d, o);
      o = cp(XB, EI[x + 3], EI[x + 4], d, o);
      d[o++] = 93;
    }
    d[o++] = 125;
  }
  o = room(o, 2);
  D[o++] = 93;
  D[o++] = 125;
  O = o;
  EC = 0;
  XO = 0;
}

/**
 * The fields of one record from i, each written as "...", separated by commas, at o (the caller has written the
 * record's "["). Returns the count of fields, or -1 when the record runs past the window; hands back in T_*.
 */
function recordFn(s, d, i, o, line, n, width) {
  let count = 0;
  let cutO = 0;
  for (;;) {
    if (count > 0) d[o++] = 44;
    d[o++] = 34;
    const vs = o;
    const quoted = s[i] === 92 && s[i + 1] === 34 && i + 6 <= n;
    if (quoted) quotedFn(s, d, i, o, line, n);
    else plainFn(s, d, i, o, line, n);
    const ended = T_END;
    if (ended === MORE) return -1;
    i = T_I;
    o = T_O;
    line = T_LINE;
    count += 1;
    if (ended !== COMMA) {
      T_BLANK = count === 1 && o === vs && !quoted;
      d[o++] = 34;
      if (count === width) cutO = o;
      break;
    }
    d[o++] = 34;
    if (count === width) cutO = o;
  }
  T_I = i;
  T_O = o;
  T_LINE = line;
  T_CUT = cutO;
  return count;
}

/** The whole cases array from I, every case's answer written at O. */
function scanAll() {
  ensure(64);
  if (S[I] !== 91) throw new NonCanonical();
  I += 1;
  O = put(O, bytes('['));
  let first = true;
  for (;;) {
    if (!beginCase(first)) break;
    first = false;
    let s = S;
    let d = D;
    let n = N;
    let i = I;
    let o = O;
    let line = 1;
    let k = 0;
    let width = -1;
    let firstOff = -1;
    let endOff = -1;
    for (;;) {
      if (n - i < LOW && !EOF) {
        O = o;
        refill(i, false);
        s = S;
        d = D;
        n = N;
        i = 0;
      }
      if (o > FLUSH_AT) {
        o = flushOut(o);
        d = D;
      }
      // Lines with no characters are no records: skip LF and CRLF.
      let c = s[i];
      while (c === 92) {
        const e = s[i + 1];
        if (e === 110) i += 2;
        else if (e === 114 && s[i + 2] === 92 && s[i + 3] === 110) i += 4;
        else break;
        line += 1;
        if (n - i < LOW && !EOF) {
          O = o;
          refill(i, false);
          s = S;
          d = D;
          n = N;
          i = 0;
        }
        c = s[i];
      }
      if (c === 34) {
        if (i >= n) throw new NonCanonical();
        break;
      }
      const recI = i;
      const recO = o;
      const recEC = EC;
      const recXO = XO;
      const recLine = line;
      RL = line;
      RK = k;
      if (k === 0) o += 24;
      else if (k > 1) d[o++] = 44;
      d[o++] = 91;
      const count = recordFn(s, d, i, o, line, n, width);
      if (count < 0) {
        // The record runs past the window: read it again from its start after a refill (or a larger window).
        if (EOF) throw new NonCanonical();
        o = recO;
        EC = recEC;
        XO = recXO;
        line = recLine;
        O = o;
        refill(recI, recI === 0);
        s = S;
        d = D;
        n = N;
        i = 0;
        continue;
      }
      i = T_I;
      o = T_O;
      line = T_LINE;
      const cutO = T_CUT;
      // A line left with no characters (only dropped CRs) is no record; its errors stay.
      if (T_BLANK) {
        o = recO;
        continue;
      }
      if (width < 0) width = count;
      if (k > 0) {
        if (count < width) {
          o = padShort(count, width, o);
          d = D;
        } else if (count > width) {
          longRow(d, cutO + 1, o);
          o = cutO;
        }
      }
      d[o++] = 93;
      if (k === 0) {
        firstOff = FLUSHED + recO;
        endOff = FLUSHED + o;
        o += 9;
      }
      k += 1;
    }
    I = i;
    O = o;
    endCase(k, firstOff, endOff);
  }
}

/** Reset the reader for one source (a file descriptor or a buffer) and one sink (a file descriptor or memory). */
function open(srcFd, srcMem, window, outFd) {
  SRC_FD = srcFd;
  SRC_MEM = srcMem;
  SRC_POS = 0;
  setS(Buffer.allocUnsafe(window + 8));
  LOW = Math.min(16384, window >> 2);
  N = 0;
  I = 0;
  EOF = false;
  OUT_FD = outFd;
  FLUSHED = 0;
  FLUSH_AT = outFd >= 0 ? Math.min(FLUSH, window) : 256;
  setD(Buffer.allocUnsafe(FLUSH_AT + 3 * S.length + 4096));
  O = 0;
  EC = 0;
  XO = 0;
  refill(0, false);
}

/** The answers JSON for a cases JSON held in memory, as bytes. */
function answerBuffer(src, window) {
  open(-1, src, window, -1);
  scanAll();
  const out = D.subarray(0, O);
  S = null;
  D = null;
  SV = null;
  DV = null;
  SRC_MEM = null;
  return out;
}

/** cases.json re-spelled the one way the fast reader reads: JSON.stringify of {id, input: {text, header}}. */
function canonical(text) {
  const cases = JSON.parse(text);
  const out = [];
  for (const c of cases) out.push({ id: 'x', input: { text: String(c.input.text), header: c.input.header === true } });
  return Buffer.from(JSON.stringify(out), 'utf8');
}

/**
 * The harness's run: /input/cases.json to /output/answers.json. `window` (the input window's size) and `strict`
 * (throw rather than fall back to the canonical spelling) are for tests only; the harness passes neither.
 */
export function main(inputDir, outputDir, window = WINDOW, strict = false) {
  const inPath = join(inputDir, 'cases.json');
  const outPath = join(outputDir, 'answers.json');
  let inFd = -1;
  let outFd = -1;
  try {
    inFd = openSync(inPath, 'r');
    outFd = openSync(outPath, 'w');
    open(inFd, null, window, outFd);
    scanAll();
    writeAll(D, 0, O);
  } catch (e) {
    if (strict) throw e;
    // Not the plain layout (or anything unexpected): answer from the canonical spelling of the same cases.
    if (inFd >= 0) closeSync(inFd);
    if (outFd >= 0) closeSync(outFd);
    inFd = -1;
    outFd = -1;
    const src = canonical(readFileSync(inPath, 'utf8'));
    writeFileSync(outPath, answerBuffer(src, src.length + 64));
  }
  if (inFd >= 0) closeSync(inFd);
  if (outFd >= 0) closeSync(outFd);
  S = null;
  D = null;
  SV = null;
  DV = null;
}

/**
 * csv-reader 1.0.0's answer for one case's input {text, header}: {columns, rows, errors}. The same reader over a
 * single case, returned as the JSON value.
 */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const one = Buffer.from(JSON.stringify([{ id: 'x', input: { text, header } }]), 'utf8');
  return JSON.parse(answerBuffer(one, one.length + 64).toString('utf8'))[0];
}

// One tiny text per branch of the policy, read through a tiny window so the refill, the record restart and the
// window growth run too. V8 compiles the hot loop for the branches it has seen; walking each one first keeps the
// real input from meeting a branch the compiled code never planned for.
const WARM_TEXTS = [
  '\uFEFFa,b,c\r\n1,2,3\r\n',
  '"x,y","a""b","c\r\nd"\r\n',
  '"p"junk,q\r\n',
  'a\rb,c\r\n',
  '"open,never closes\r\n1,2\r\n',
  '\n\r\n\n1,2,3,4\r\n1\r\n1,2,3,4,5,6\r\n',
  'a,b\n"c\n',
  '',
  '\uFEFF',
  'é,東,"x\ry",\r\n',
  '"a"x"y,b\n',
  '\r\r\r\n,\n""\n',
  'a\tb,\u0001,\\,\uD800,"q\u0002"\n' + 'long field '.repeat(12) + ',x\n',
];
try {
  const warm = [];
  for (let i = 0; i < WARM_TEXTS.length; i++) warm.push({ id: 'g', input: { text: WARM_TEXTS[i], header: i % 2 === 0 } });
  for (let i = 0; i < WARM_TEXTS.length; i++) warm.push({ id: 'g', input: { text: WARM_TEXTS[i], header: i % 2 !== 0 } });
  answerBuffer(Buffer.from(JSON.stringify(warm), 'utf8'), 48);
} catch {
  // a warm-up that somehow throws must never stop the entry: it changes nothing about the answers
}
EC = 0;
XO = 0;
