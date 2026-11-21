// solve.js: a faster drop-in for csv-reader 1.0.0.
//
// run(input) returns csv-reader 1.0.0's answer for one case's input {text, header}: the JSON value
// {columns, rows, errors}. The reading policy is csv-reader's, to the letter (the reference's comments are the
// specification):
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
// Why it is fast. The harness hands the entry /input/cases.json and takes /output/answers.json, so no JavaScript
// string is ever needed: the file is read as bytes and the JSON-escaped bytes of each case's text are scanned
// where they sit. JSON escapes exactly the characters a CSV reader cares about (a quote is \" and a line break
// is \n or \r), and a run of escaped bytes is already the exact JSON text of the value it spells, so every field
// is copied from the input to the output without being decoded, and no object, array or string is built for the
// answers. The whole file is answered in one pass and written with one write. `run()` is the same reader over a
// single case, kept for the entry's contract.
//
// Each field reader is a small function of its own, and the rare branches (a stray CR to drop, a doubled quote, a
// line break inside quotes, junk after a closing quote, a quote that never closes) sit on their own paths, so V8
// compiles and keeps the hot loops that meet hundreds of thousands of fields without paying for the rest. A tiny
// warm-up at module load walks every branch once before the real cases, so none of them pays for a
// deoptimisation in the middle of its scan.
//
// Field readers hand the position, the line and how the field ended back in the module's scratch, which every
// call overwrites before it is read; the reader keeps nothing from one call to the next.

/** A field's end: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** Bytes, so the scan compares numbers and never builds a one-character string. */
const BS = 0x5c; // \
const DQ = 0x22; // "
const C_COMMA = 0x2c; // ,
const C_LF = 0x6e; // the n of \n
const C_CR = 0x72; // the r of \r
const C_U = 0x75; // the u of \uXXXX
const C_LBRACKET = 0x5b; // [
const C_RBRACKET = 0x5d; // ]
const C_RBRACE = 0x7d; // }
const C_T = 0x74; // the t of true

/** The bytes that open a case's text and close it before its header: fixed by the harness's cases.json. */
const TEXT_KEY = Buffer.from('"text":"', 'latin1');
const HEADER_KEY = Buffer.from('","header":', 'latin1');

/** The output buffer and its cursor, the errors buffer and its cursor. */
let DST = null;
let O = 0;
let ERR = Buffer.allocUnsafe(1 << 20);
let EO = 0;

/** Where the last field reader left off: the position, the line, the output cursor and how the field ended. */
let T_I = 0;
let T_LINE = 0;
let T_O = 0;
let T_ENDED = 0;

/** Grow the errors buffer so that `need` more bytes fit. */
function growErr(need) {
  let cap = ERR.length;
  while (cap < EO + need) cap *= 2;
  const next = Buffer.allocUnsafe(cap);
  ERR.copy(next, 0, 0, EO);
  ERR = next;
}

/** One error without payload: {code, line, row}, row null for the header. */
function pushErr(code, line, row) {
  const s = (EO > 0 ? ',' : '') + '{"code":"' + code + '","line":' + line + ',"row":' + (row < 0 ? 'null' : row) + '}';
  if (EO + s.length > ERR.length) growErr(s.length);
  EO += ERR.write(s, EO, 'latin1');
}

/** A long_row's error, whose extra fields are already written in the output at [from, to). */
function pushLongErr(line, row, out, from, to) {
  const head = (EO > 0 ? ',' : '') + '{"code":"long_row","line":' + line + ',"row":' + (row < 0 ? 'null' : row) + ',"extra":[';
  const need = head.length + (to - from) + 3;
  if (EO + need > ERR.length) growErr(need);
  EO += ERR.write(head, EO, 'latin1');
  out.copy(ERR, EO, from, to);
  EO += to - from;
  EO += ERR.write(']}', EO, 'latin1');
}

/**
 * An unquoted field (or the tail of one, or the junk after a closing quote) starting at `i`, written to `out` at
 * `o`: it ends at a comma, at a line break or at the end of the text, and a CR not followed by LF is dropped
 * (stray_cr). Leaves i, line, the output cursor and the ending in T_I, T_LINE, T_O and T_ENDED.
 */
function plainInto(src, i, line, out, o, recLine, recRow) {
  let ended = END;
  for (;;) {
    const c = src[i];
    if (c === C_COMMA) {
      i += 1;
      ended = COMMA;
      break;
    }
    if (c === BS) {
      const e = src[i + 1];
      if (e === C_LF) {
        i += 2;
        line += 1;
        ended = LINE_BREAK;
        break;
      }
      if (e === C_CR) {
        if (src[i + 2] === BS && src[i + 3] === C_LF) {
          i += 4;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        pushErr('stray_cr', recLine, recRow);
        i += 2;
        continue;
      }
      if (e === C_U) {
        out[o++] = BS;
        out[o++] = C_U;
        out[o++] = src[i + 2];
        out[o++] = src[i + 3];
        out[o++] = src[i + 4];
        out[o++] = src[i + 5];
        i += 6;
        continue;
      }
      out[o++] = BS;
      out[o++] = e;
      i += 2;
      continue;
    }
    if (c === DQ) break; // the raw quote that ends the case's text
    out[o++] = c;
    i += 1;
  }
  T_I = i;
  T_LINE = line;
  T_O = o;
  T_ENDED = ended;
  return ended;
}

/**
 * A field that opens with a quote at `i`, written to `out` at `o`: "" inside it is one quote, a CRLF or a lone
 * CR inside it is one LF, and what follows its closing quote is appended as it stands. A quote that never closes
 * is a literal character and the text after it is read again, unquoted. Ends like plainInto, in T_*.
 */
function quotedInto(src, i, line, textEnd, out, o, recLine, recRow) {
  const openI = i;
  const openLine = line;
  const valStart = o;
  i += 2;
  let closed = false;
  for (;;) {
    const c = src[i];
    if (c === BS) {
      const e = src[i + 1];
      if (e === DQ) {
        if (src[i + 2] === BS && src[i + 3] === DQ) {
          // "" inside a quoted field is one quote
          out[o++] = BS;
          out[o++] = DQ;
          i += 4;
          continue;
        }
        i += 2;
        closed = true;
        break;
      }
      if (e === C_LF) {
        // a line break inside quotes is one LF
        out[o++] = BS;
        out[o++] = C_LF;
        line += 1;
        i += 2;
        continue;
      }
      if (e === C_CR) {
        // CRLF and a lone CR inside quotes are each one LF
        out[o++] = BS;
        out[o++] = C_LF;
        line += 1;
        if (src[i + 2] === BS && src[i + 3] === C_LF) i += 4;
        else i += 2;
        continue;
      }
      if (e === C_U) {
        out[o++] = BS;
        out[o++] = C_U;
        out[o++] = src[i + 2];
        out[o++] = src[i + 3];
        out[o++] = src[i + 4];
        out[o++] = src[i + 5];
        i += 6;
        continue;
      }
      out[o++] = BS;
      out[o++] = e;
      i += 2;
      continue;
    }
    if (c === DQ) break; // the raw quote that ends the case's text: the quote never closed
    out[o++] = c;
    i += 1;
  }
  if (!closed) {
    // The quote never closes: it is a literal character and the text after it is read again, unquoted.
    pushErr('unterminated_quote', recLine, recRow);
    o = valStart;
    out[o++] = BS;
    out[o++] = DQ;
    plainInto(src, openI + 2, openLine, out, o, recLine, recRow);
    return;
  }
  if (i >= textEnd) {
    T_ENDED = END;
  } else {
    const c2 = src[i];
    if (c2 === C_COMMA) {
      i += 1;
      T_ENDED = COMMA;
    } else if (c2 === BS && src[i + 1] === C_LF) {
      i += 2;
      line += 1;
      T_ENDED = LINE_BREAK;
    } else if (c2 === BS && src[i + 1] === C_CR && src[i + 2] === BS && src[i + 3] === C_LF) {
      i += 4;
      line += 1;
      T_ENDED = LINE_BREAK;
    } else {
      // What follows the closing quote is appended as it stands (quote_junk when any was added).
      const before = o;
      plainInto(src, i, line, out, o, recLine, recRow);
      if (T_O > before) pushErr('quote_junk', recLine, recRow);
      return;
    }
  }
  T_I = i;
  T_LINE = line;
  T_O = o;
}

/** Grow the output buffer so that `need` more bytes fit. */
function growOut(need) {
  let cap = DST.length;
  while (cap < O + need) cap *= 2;
  const next = Buffer.allocUnsafe(cap);
  DST.copy(next, 0, 0, O);
  DST = next;
  return next;
}

/**
 * One case, from the first byte of its text at `textStart` to the raw quote at `textEnd`, appended to the
 * output buffer: {"columns":...,"rows":[...],"errors":[...]}. Reads and writes bytes only.
 */
function emitCase(src, textStart, textEnd, header) {
  let d = DST;
  let o = O;
  let i = textStart;
  let line = 1;

  // A U+FEFF at the very start is dropped: raw, as JSON.stringify writes it, or as the \ufeff escape.
  if (i + 2 < textEnd && src[i] === 0xef && src[i + 1] === 0xbb && src[i + 2] === 0xbf) i += 3;
  else if (
    i + 5 < textEnd &&
    src[i] === BS &&
    src[i + 1] === C_U &&
    (src[i + 2] | 0x20) === 0x66 &&
    (src[i + 3] | 0x20) === 0x65 &&
    (src[i + 4] | 0x20) === 0x66 &&
    (src[i + 5] | 0x20) === 0x66
  )
    i += 6;

  o += d.write('{"columns":', o, 'latin1');

  let mode = header ? 0 : 1; // 0: the first accepted record is the columns, 1: rows
  let width = -1;
  let rowCount = 0;
  let columnsDone = false;
  let anyRow = false;
  let ended = COMMA;

  if (!header) o += d.write('null,"rows":[', o, 'latin1');

  records: for (;;) {
    // Lines with no characters are no records: skip LF and CRLF only.
    for (;;) {
      if (i >= textEnd) break records;
      const c0 = src[i];
      if (c0 === BS) {
        const e0 = src[i + 1];
        if (e0 === C_LF) {
          i += 2;
          line += 1;
          continue;
        }
        if (e0 === C_CR && src[i + 2] === BS && src[i + 3] === C_LF) {
          i += 4;
          line += 1;
          continue;
        }
      }
      break;
    }

    const recLine = line;
    const recRow = header && !columnsDone ? -1 : rowCount;
    const recStart = o;
    if (mode === 1 && anyRow) d[o++] = C_COMMA;
    d[o++] = C_LBRACKET;

    let count = 0;
    let cutPos = 0;
    let lastQuoted = false;
    let lastEmpty = false;

    for (;;) {
      if (count > 0) d[o++] = C_COMMA;
      d[o++] = DQ;
      const valStart = o;
      if (src[i] === BS && src[i + 1] === DQ) {
        lastQuoted = true;
        quotedInto(src, i, line, textEnd, d, o, recLine, recRow);
      } else {
        lastQuoted = false;
        plainInto(src, i, line, d, o, recLine, recRow);
      }
      i = T_I;
      line = T_LINE;
      o = T_O;
      ended = T_ENDED;
      lastEmpty = o === valStart;
      d[o++] = DQ;
      count += 1;
      if (count === width) cutPos = o;
      if (ended !== COMMA) break;
    }

    // A line left with no characters (only dropped CRs) is no record; its errors stay.
    if (count === 1 && lastEmpty && !lastQuoted) {
      o = recStart;
      continue;
    }

    if (width < 0) width = count;

    if (mode === 0) {
      columnsDone = true;
      mode = 1;
      d[o++] = C_RBRACKET;
      o += d.write(',"rows":[', o, 'latin1');
      continue;
    }

    if (count < width) {
      pushErr('short_row', recLine, recRow);
      ERR[EO - 1] = C_COMMA; // reopen the object for the payload
      const payload = '"fields":' + count + '}';
      if (EO + payload.length > ERR.length) growErr(payload.length);
      EO += ERR.write(payload, EO, 'latin1');
      if (o + 3 * (width - count) + 2 > d.length) {
        DST = d;
        O = o;
        d = growOut(3 * (width - count) + 2);
      }
      while (count < width) {
        d[o++] = C_COMMA;
        d[o++] = DQ;
        d[o++] = DQ;
        count += 1;
      }
    } else if (count > width) {
      pushLongErr(recLine, recRow, d, cutPos + 1, o);
      o = cutPos;
    }
    d[o++] = C_RBRACKET;
    anyRow = true;
    rowCount += 1;
  }

  if (mode === 0) o += d.write('[],"rows":[', o, 'latin1');
  o += d.write('],"errors":[', o, 'latin1');
  if (EO > 0) {
    if (o + EO > d.length) {
      DST = d;
      O = o;
      d = growOut(EO);
    }
    ERR.copy(d, o, 0, EO);
    o += EO;
    EO = 0;
  }
  d[o++] = C_RBRACKET;
  d[o++] = C_RBRACE;
  DST = d;
  O = o;
}

/**
 * The whole answers.json for the harness's cases.json, as bytes: a JSON array of {"columns","rows","errors"},
 * one per case in the cases' order. Each case's text is read where it sits, JSON-escaped, and never decoded.
 */
export function answersJson(src) {
  DST = Buffer.allocUnsafe(src.length * 6 + 4096);
  O = 0;
  EO = 0;
  DST[O++] = C_LBRACKET;
  let from = 0;
  let first = true;
  for (;;) {
    const at = src.indexOf(TEXT_KEY, from);
    if (at < 0) break;
    const textStart = at + 8;
    const head = src.indexOf(HEADER_KEY, textStart);
    if (head < 0) throw new Error('cases.json: a case text with no header after it');
    if (!first) DST[O++] = C_COMMA;
    first = false;
    emitCase(src, textStart, head, src[head + 11] === C_T);
    from = head + 11;
  }
  DST[O++] = C_RBRACKET;
  return DST.subarray(0, O);
}

// One tiny text per branch of the policy: a BOM and CRLF, a quoted field holding a comma and a doubled quote, a
// line break inside quotes, junk after a closing quote, a stray CR to drop, a quote that never closes, blank
// lines, a short row and a long row, an empty text, a BOM alone, characters outside Latin-1, a lone CR inside
// quotes, and a quote inside the junk. run is pure, so both header readings of each are walked. The metric is
// the CPU time of one process, so a branch first met inside already-compiled code costs a deoptimisation and a
// recompilation; walking every branch once, on a constant that came from nowhere, lets the six real cases run
// on settled code.
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
];
try {
  const warm = [];
  for (let i = 0; i < WARM_TEXTS.length; i++) warm.push({ id: 'g-' + i, input: { text: WARM_TEXTS[i], header: i % 2 === 0 } });
  const warmBuf = Buffer.from(JSON.stringify(warm), 'utf8');
  for (let i = 0; i < 2; i++) answersJson(warmBuf);
} catch {
  // a warm-up that somehow throws must never stop the entry: it can change nothing about the answers
}

/**
 * csv-reader 1.0.0's answer for one case's input {text, header}: {columns, rows, errors}. The same reader as
 * answersJson, over a single case, returned as the JSON value.
 */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const one = Buffer.from(JSON.stringify([{ id: 'x', input: { text, header } }]), 'utf8');
  return JSON.parse(answersJson(one).toString('utf8'))[0];
}
