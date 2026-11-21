// solve.js — a faster drop-in for csv-reader 1.0.0: run(input) returns exactly the answer csv-reader returns
// for one case's input {text, header}, the JSON value {columns, rows, errors}.
//
// The reader keeps csv-reader 1.0.0's policy to the letter (its comments are the specification):
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
// The speed comes from the same reading done three ways cheaper: the text is walked by character code, every
// field is a slice of the original text instead of a character-at-a-time concatenation, and the work is split so
// that the loop that meets a million fields is one short function and every rare branch (a stray CR to drop, a
// doubled quote, a line break inside quotes, junk after a closing quote, a quote that never closes) is a function
// of its own that only a broken field ever calls. V8 compiles each of them on its own, so a branch first met in
// the middle of the third case does not throw away the code the other fields are running in.
//
// Field readers hand back three things besides the value: where the text goes on, the line it is on, and how the
// field ended. They leave those in the module's scratch, which every call overwrites before it is read, so the
// reader keeps nothing from one call to the next and the answers are a pure function of the input.

/** A field's end: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** Characters as numbers, so the scan compares numbers and never builds a one-character string. */
const QUOTE = 34;
const COMMA_CH = 44;
const LF = 10;
const CR = 13;
const BOM = 0xfeff;

/** The position, the line, how the field ended and how many characters it kept, as a field reader leaves them. */
let S_pos = 0;
let S_line = 1;
let S_ended = END;
let S_added = 0;

/**
 * csv-reader 1.0.0's answer for one case: {columns, rows, errors} for {text, header}.
 * Pure: no clock, no randomness, nothing kept from one call to the next.
 */
export function run(input) {
  const text = String(input.text);
  const n = text.length;
  const header = input.header === true;
  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === BOM) pos = 1;

  // The record being read: the line it starts on, and its index in rows (-1 while it is the header).
  let recordLine = 1;
  let recordRow = -1;

  let c = 0;
  for (;;) {
    // Lines with no characters are no records: skip LF and CRLF only.
    while (pos < n) {
      c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? -1 : rows.length;

    const fields = [];
    let quoted = false; // how the record's last field opened
    let ended = COMMA;
    do {
      let value;
      if (text.charCodeAt(pos) === QUOTE) {
        quoted = true;
        value = quotedField(text, n, pos, line, errors, recordLine, recordRow);
      } else {
        quoted = false;
        value = plainField(text, n, pos, line, errors, recordLine, recordRow);
      }
      pos = S_pos;
      line = S_line;
      ended = S_ended;
      fields.push(value);
    } while (ended === COMMA);

    // A line left with no characters (only dropped CRs) is no record; its errors stay.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length !== width) settleRagged(fields, width, recordLine, recordRow, errors);
    rows.push(fields);
  }

  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}

/** Pad a short record with '' (short_row) or cut a long one (long_row) to the first record's width, in place. */
function settleRagged(fields, width, recordLine, recordRow, errors) {
  const row = recordRow < 0 ? null : recordRow;
  if (fields.length < width) {
    errors.push({ code: 'short_row', line: recordLine, row, fields: fields.length });
    while (fields.length < width) fields.push('');
  } else {
    errors.push({ code: 'long_row', line: recordLine, row, extra: fields.splice(width) });
  }
}

/**
 * An unquoted field starting at `start`: the common case, one slice of the text and no allocation but the field.
 * A CR not followed by LF drops out to plainAfterStray, which builds the field from its pieces.
 */
function plainField(text, n, start, line, errors, recordLine, recordRow) {
  let i = start;
  for (;;) {
    if (i >= n) {
      S_pos = n;
      S_line = line;
      S_ended = END;
      S_added = i - start;
      return text.slice(start, i);
    }
    const c = text.charCodeAt(i);
    if (c === COMMA_CH) {
      S_pos = i + 1;
      S_line = line;
      S_ended = COMMA;
      S_added = i - start;
      return text.slice(start, i);
    }
    if (c === LF) {
      S_pos = i + 1;
      S_line = line + 1;
      S_ended = LINE_BREAK;
      S_added = i - start;
      return text.slice(start, i);
    }
    if (c === CR) {
      if (i + 1 < n && text.charCodeAt(i + 1) === LF) {
        S_pos = i + 2;
        S_line = line + 1;
        S_ended = LINE_BREAK;
        S_added = i - start;
        return text.slice(start, i);
      }
      return plainAfterStray(text, n, start, i, line, errors, recordLine, recordRow);
    }
    i += 1;
  }
}

/** An unquoted field whose first CR not followed by LF sits at `stray`: drop it (stray_cr) and go on. */
function plainAfterStray(text, n, start, stray, line, errors, recordLine, recordRow) {
  const row = recordRow < 0 ? null : recordRow;
  let value = text.slice(start, stray);
  let piece = stray; // where the run not yet taken into `value` starts (the dropped CR itself, at first)
  let added = stray - start;
  let j = stray;
  for (;;) {
    if (j >= n) {
      if (j > piece) value += text.slice(piece, j);
      S_pos = n;
      S_line = line;
      S_ended = END;
      S_added = added + j - piece;
      return value;
    }
    const c = text.charCodeAt(j);
    if (c === COMMA_CH) {
      if (j > piece) value += text.slice(piece, j);
      S_pos = j + 1;
      S_ended = COMMA;
      S_added = added + j - piece;
      S_line = line;
      return value;
    }
    if (c === LF) {
      if (j > piece) value += text.slice(piece, j);
      S_pos = j + 1;
      S_line = line + 1;
      S_ended = LINE_BREAK;
      S_added = added + j - piece;
      return value;
    }
    if (c === CR) {
      if (j + 1 < n && text.charCodeAt(j + 1) === LF) {
        if (j > piece) value += text.slice(piece, j);
        S_pos = j + 2;
        S_line = line + 1;
        S_ended = LINE_BREAK;
        S_added = added + j - piece;
        return value;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row });
      if (j > piece) value += text.slice(piece, j);
      added += j - piece;
      j += 1;
      piece = j;
      continue;
    }
    j += 1;
  }
}

/**
 * A field that opens with a quote at `start`. Its fast path is the closing quote found with no escape and no line
 * break in it, one slice; anything else goes through the quoted scan or the two tails below.
 */
function quotedField(text, n, start, line, errors, recordLine, recordRow) {
  const open = start;
  const openLine = line;
  let pos = start + 1;
  let piece = pos; // where the run of characters not yet taken into `value` starts
  let value = '';
  let closed = false;
  let c = 0;
  while (pos < n) {
    c = text.charCodeAt(pos);
    if (c === QUOTE) {
      if (pos + 1 < n && text.charCodeAt(pos + 1) === QUOTE) {
        // "" inside a quoted field is one quote
        value = value + text.slice(piece, pos) + '"';
        pos += 2;
        piece = pos;
        continue;
      }
      closed = true;
      break;
    }
    if (c === CR) {
      // CRLF and a lone CR inside quotes are each one LF
      value = value + text.slice(piece, pos) + '\n';
      pos += pos + 1 < n && text.charCodeAt(pos + 1) === LF ? 2 : 1;
      line += 1;
      piece = pos;
      continue;
    }
    if (c === LF) line += 1;
    pos += 1;
  }
  if (!closed) {
    // The quote never closes: it is a literal character and the text after it is read again, unquoted.
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow < 0 ? null : recordRow });
    const rest = plainField(text, n, open + 1, openLine, errors, recordLine, recordRow);
    S_added += 1;
    return '"' + rest;
  }
  value = value === '' ? text.slice(piece, pos) : value + text.slice(piece, pos);
  pos += 1; // past the closing quote
  if (pos >= n) {
    S_pos = n;
    S_line = line;
    S_ended = END;
    return value;
  }
  c = text.charCodeAt(pos);
  if (c === COMMA_CH) {
    S_pos = pos + 1;
    S_line = line;
    S_ended = COMMA;
    return value;
  }
  if (c === LF) {
    S_pos = pos + 1;
    S_line = line + 1;
    S_ended = LINE_BREAK;
    return value;
  }
  if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
    S_pos = pos + 2;
    S_line = line + 1;
    S_ended = LINE_BREAK;
    return value;
  }
  // What follows the closing quote is appended as it stands (quote_junk when any was added).
  S_line = line;
  return value + junkAfterQuote(text, n, pos, line, errors, recordLine, recordRow);
}

/** The unquoted text after a closing quote, appended to the field; it ends the field and may be quote_junk. */
function junkAfterQuote(text, n, pos, line, errors, recordLine, recordRow) {
  const junk = plainField(text, n, pos, line, errors, recordLine, recordRow);
  if (S_added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow < 0 ? null : recordRow });
  return junk;
}

// One tiny text per branch of the policy: a BOM and CRLF, a quoted field holding a comma and a doubled quote, a
// line break inside quotes, junk after a closing quote, a stray CR to drop, a quote that never closes, blank
// lines, a short row and a long row, an empty text, a BOM alone, characters outside Latin-1, a lone CR inside
// quotes, and a quote inside the junk. run is pure, so both header readings of each are dropped. The metric is
// the CPU time of one process, so a branch first met inside already-compiled code costs a deoptimisation and a
// recompilation; walking every branch once, on a constant that came from nowhere, lets the six real cases run on
// settled code.
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
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < WARM_TEXTS.length; j++) {
      run({ text: WARM_TEXTS[j], header: i === 0 });
    }
  }
} catch {
  // a warm-up that somehow throws must never stop the entry: it can change nothing about the answers
}
