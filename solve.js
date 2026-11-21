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
// The speed comes from doing the same reading with the text scanned by character code and every field taken as a
// slice of the original text instead of a character-at-a-time concatenation, and from keeping the whole scan in
// one flat loop: no per-field function call, no token tree, no allocation but the answers themselves. The rare
// paths the policy needs (a stray CR to drop, a doubled quote, a line break inside quotes, an unterminated quote)
// leave the fast slice and build the same string the reference builds.
//
// The last block of this file warms the reader up on a few tiny texts before any case arrives. The metric is the
// CPU time of one process, so a branch first met inside already-compiled code costs a deoptimisation and a
// recompilation; walking every branch of the policy once, on a constant that came from nowhere, pays for the six
// real cases to run on settled code. It reads no case and keeps nothing.

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
        // ---- a field that opens with a quote ----
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        let piece = pos; // where the run of characters not yet taken into `value` starts
        value = '';
        let closed = false;
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
        if (closed) {
          value = value === '' ? text.slice(piece, pos) : value + text.slice(piece, pos);
          pos += 1; // past the closing quote
          if (pos >= n) {
            ended = END;
          } else {
            c = text.charCodeAt(pos);
            if (c === COMMA_CH) {
              pos += 1;
              ended = COMMA;
            } else if (c === LF) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // what follows the closing quote is appended as it stands (quote_junk when any was added)
              let added = 0;
              let start = pos;
              let i = pos;
              for (;;) {
                if (i >= n) {
                  if (i > start) {
                    value += text.slice(start, i);
                    added += i - start;
                  }
                  pos = n;
                  ended = END;
                  break;
                }
                c = text.charCodeAt(i);
                if (c === COMMA_CH) {
                  if (i > start) {
                    value += text.slice(start, i);
                    added += i - start;
                  }
                  pos = i + 1;
                  ended = COMMA;
                  break;
                }
                if (c === LF) {
                  if (i > start) {
                    value += text.slice(start, i);
                    added += i - start;
                  }
                  pos = i + 1;
                  line += 1;
                  ended = LINE_BREAK;
                  break;
                }
                if (c === CR) {
                  if (i + 1 < n && text.charCodeAt(i + 1) === LF) {
                    if (i > start) {
                      value += text.slice(start, i);
                      added += i - start;
                    }
                    pos = i + 2;
                    line += 1;
                    ended = LINE_BREAK;
                    break;
                  }
                  errors.push({ code: 'stray_cr', line: recordLine, row: recordRow < 0 ? null : recordRow });
                  if (i > start) {
                    value += text.slice(start, i);
                    added += i - start;
                  }
                  i += 1;
                  pos = i;
                  start = i;
                  continue;
                }
                i += 1;
              }
              if (added > 0) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow < 0 ? null : recordRow });
              }
            }
          }
        } else {
          // The quote never closes: it is a literal character and the text after it is read again, unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow < 0 ? null : recordRow });
          value = '"';
          let start = pos;
          let i = pos;
          for (;;) {
            if (i >= n) {
              if (i > start) value += text.slice(start, i);
              pos = n;
              ended = END;
              break;
            }
            c = text.charCodeAt(i);
            if (c === COMMA_CH) {
              if (i > start) value += text.slice(start, i);
              pos = i + 1;
              ended = COMMA;
              break;
            }
            if (c === LF) {
              if (i > start) value += text.slice(start, i);
              pos = i + 1;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            if (c === CR) {
              if (i + 1 < n && text.charCodeAt(i + 1) === LF) {
                if (i > start) value += text.slice(start, i);
                pos = i + 2;
                line += 1;
                ended = LINE_BREAK;
                break;
              }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow < 0 ? null : recordRow });
              if (i > start) value += text.slice(start, i);
              i += 1;
              pos = i;
              start = i;
              continue;
            }
            i += 1;
          }
        }
      } else {
        // ---- an unquoted field: the common case, one slice of the text ----
        quoted = false;
        let start = pos;
        let i = pos;
        let stray = -1; // where the first CR not followed by LF sits, -1 when there is none
        for (;;) {
          if (i >= n) {
            value = text.slice(start, i);
            pos = n;
            ended = END;
            break;
          }
          c = text.charCodeAt(i);
          if (c === COMMA_CH) {
            value = text.slice(start, i);
            pos = i + 1;
            ended = COMMA;
            break;
          }
          if (c === LF) {
            value = text.slice(start, i);
            pos = i + 1;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          if (c === CR) {
            if (i + 1 < n && text.charCodeAt(i + 1) === LF) {
              value = text.slice(start, i);
              pos = i + 2;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            stray = i;
            break;
          }
          i += 1;
        }
        if (stray >= 0) {
          // A CR not followed by LF is dropped (stray_cr) and the field goes on: build it from its pieces.
          value = text.slice(start, stray);
          let pieceStart = stray;
          let j = stray;
          for (;;) {
            if (j >= n) {
              if (j > pieceStart) value += text.slice(pieceStart, j);
              pos = n;
              ended = END;
              break;
            }
            c = text.charCodeAt(j);
            if (c === COMMA_CH) {
              if (j > pieceStart) value += text.slice(pieceStart, j);
              pos = j + 1;
              ended = COMMA;
              break;
            }
            if (c === LF) {
              if (j > pieceStart) value += text.slice(pieceStart, j);
              pos = j + 1;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            if (c === CR) {
              if (j + 1 < n && text.charCodeAt(j + 1) === LF) {
                if (j > pieceStart) value += text.slice(pieceStart, j);
                pos = j + 2;
                line += 1;
                ended = LINE_BREAK;
                break;
              }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow < 0 ? null : recordRow });
              if (j > pieceStart) value += text.slice(pieceStart, j);
              j += 1;
              pieceStart = j;
              continue;
            }
            j += 1;
          }
        }
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line left with no characters (only dropped CRs) is no record; its errors stay.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    const row = recordRow < 0 ? null : recordRow;
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}

// One tiny text per branch of the policy: a BOM and CRLF, a quoted field holding a comma and a doubled quote, a
// line break inside quotes, junk after a closing quote, a stray CR to drop, a quote that never closes, blank
// lines, a short row and a long row, an empty text, a BOM alone, characters outside Latin-1, a lone CR inside
// quotes, and a quote inside the junk. run is pure, so both header readings of each are dropped.
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
