// solve.js — a fast drop-in for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}, with the same broken-row policy (BOM dropped, records end
// at LF/CRLF, empty lines are no record, stray CRs dropped with an error, quoted
// fields with "" doubling and CRLF/lone CR read as LF, quote junk appended, an
// unterminated quote read again as unquoted, short/long rows padded/cut to the first
// record's width, errors in the order met). Only the speed differs.
//
// How it is faster: the reference reads one character at a time and builds every
// field up with `+=`, one character per step. This reader instead
//   - takes a whole record at a time when the record holds no quote and no stray
//     CR, and splits it with the native String split (one native call per record);
//   - otherwise scans each field with one native regex scan for the next
//     separator, and takes the field as one slice of the input instead of
//     building it up;
//   - only falls back to segment work inside a quoted field, and only converts
//     CRs there when the segment actually holds one.
// Nothing is cached from one case to the next; every call is pure.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a U+FEFF at the very start is dropped
  let line = 1; // the line the next character is on

  // One native scan finds the next separator of either kind: the record level
  // looks for a quote, a CR or a LF; the field level for a comma, a CR or a LF.
  // Each is used with its lastIndex set before every exec, so one scan stops at
  // the nearest separator instead of three indexOf calls scanning past it.
  const SEP = /[",\r\n]/g;
  const FIELD_SEP = /[,\r\n]/g;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // What the last field read was, and how it ended; set by readUnquoted / readQuoted.
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr). Returns the field; fEnded says how it
  // ended and fAdded counts the characters kept.
  function readUnquoted(value) {
    let v = value;
    let added = 0;
    for (;;) {
      FIELD_SEP.lastIndex = pos;
      const m = FIELD_SEP.exec(text);
      if (m === null) {
        if (pos < n) {
          v += text.slice(pos);
          added += n - pos;
        }
        pos = n;
        fEnded = END;
        fAdded = added;
        return v;
      }
      const c = m[0];
      const next = m.index;
      if (c === ',') {
        if (next > pos) {
          v += text.slice(pos, next);
          added += next - pos;
        }
        pos = next + 1;
        fEnded = COMMA;
        fAdded = added;
        return v;
      }
      if (c === '\n') {
        if (next > pos) {
          v += text.slice(pos, next);
          added += next - pos;
        }
        pos = next + 1;
        line += 1;
        fEnded = LINE;
        fAdded = added;
        return v;
      }
      // A CR: a line break when followed by LF, else a dropped stray CR.
      if (text.charCodeAt(next + 1) === 10) {
        if (next > pos) {
          v += text.slice(pos, next);
          added += next - pos;
        }
        pos = next + 2;
        line += 1;
        fEnded = LINE;
        fAdded = added;
        return v;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (next > pos) {
        v += text.slice(pos, next);
        added += next - pos;
      }
      pos = next + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field; fEnded
  // says how it ended.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let closed = false;
    while (pos < n) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (q > pos) {
        // The segment up to the next quote: CRLF and lone CRs inside it are each
        // one LF, and each counts as a line.
        const seg = text.slice(pos, q);
        if (seg.indexOf('\r') !== -1) {
          const fixed = seg.replace(/\r\n?/g, '\n');
          let breaks = 0;
          let idx = -1;
          while ((idx = fixed.indexOf('\n', idx + 1)) !== -1) breaks += 1;
          line += breaks;
          value += fixed;
        } else {
          let breaks = 0;
          let idx = -1;
          while ((idx = seg.indexOf('\n', idx + 1)) !== -1) breaks += 1;
          line += breaks;
          value += seg;
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote, and the field goes on.
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it
      // is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= n) {
      fEnded = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = LINE;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = LINE;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Reads one record the slow way (it holds a quote or a stray CR). Returns its
  // fields; recQuoted says whether its last field was quoted. The common
  // unquoted field is read inline here — one regex scan and one slice, no call
  // — and only a field a stray CR splits falls back to readUnquoted.
  let recQuoted = false;
  function readRecordSlow() {
    const fields = [];
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        recQuoted = true;
        fields.push(readQuoted());
        if (fEnded !== COMMA) break;
        continue;
      }
      recQuoted = false;
      FIELD_SEP.lastIndex = pos;
      const m = FIELD_SEP.exec(text);
      if (m === null) {
        fields.push(pos < n ? text.slice(pos) : '');
        pos = n;
        break;
      }
      const c = m[0];
      const next = m.index;
      if (c === ',') {
        fields.push(text.slice(pos, next));
        pos = next + 1;
        continue;
      }
      if (c === '\n') {
        fields.push(text.slice(pos, next));
        pos = next + 1;
        line += 1;
        break;
      }
      if (text.charCodeAt(next + 1) === 10) {
        fields.push(text.slice(pos, next));
        pos = next + 2;
        line += 1;
        break;
      }
      // A stray CR: dropped, with an error, and the field keeps going, with
      // what came before it kept.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      const kept = text.slice(pos, next);
      pos = next + 1;
      fields.push(readUnquoted(kept));
      if (fEnded !== COMMA) break;
    }
    return fields;
  }

  // A record's fields, read: the header, a row at the first record's width, or no
  // record at all when the line held only stray CRs.
  function finishRecord(fields, quoted) {
    // A line left with no characters is no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the next quote, CR or LF decides. A LF first means the record
    // holds no quote and no stray CR, so it ends at this line's break and its
    // fields are one native split; a CRLF first ends it the same way. A quote
    // first, or a CR not followed by LF, goes to the slow path below.
    SEP.lastIndex = pos;
    const m = SEP.exec(text);
    if (m !== null) {
      if (m[0] === '\n') {
        const fields = text.slice(pos, m.index).split(',');
        pos = m.index + 1;
        line += 1;
        finishRecord(fields, false);
        continue;
      }
      if (m[0] === '\r' && text.charCodeAt(m.index + 1) === 10) {
        const fields = text.slice(pos, m.index).split(',');
        pos = m.index + 2;
        line += 1;
        finishRecord(fields, false);
        continue;
      }
    } else {
      // No quote, CR or LF is left: the rest of the text is one last record.
      const fields = text.slice(pos).split(',');
      pos = n;
      line += 1;
      finishRecord(fields, false);
      continue;
    }

    const fields = readRecordSlow();
    finishRecord(fields, recQuoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
