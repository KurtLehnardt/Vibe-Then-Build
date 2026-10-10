/**
 * Minimal CSV parser for OpenOutreach's export files.
 *
 * OpenOutreach does not publish a formal export schema, so this handles the
 * RFC 4180 cases that actually show up in practice: a quoted field that
 * contains a comma, `""` as an escaped quote inside a quoted field, and both
 * CRLF and LF line endings, with or without a trailing newline. No dependency
 * is pulled in for this — the grammar is small enough to hand-write correctly
 * and keeping it in-tree avoids adding a package just to read a CSV.
 */

export type CsvRow = string[];

/**
 * Thrown when the input ends while a quoted field is still open. Real-world
 * cause is a truncated export (OpenOutreach's writer process was killed or
 * crashed mid-write), not valid CSV with an unusual shape. Callers should
 * treat this as "the file is unusable" rather than take whatever `parseCsv`
 * managed to build before the end of input — importing a field that silently
 * swallowed the rest of the file is worse than reporting nothing.
 */
export class UnterminatedQuoteError extends Error {
  constructor() {
    super("CSV input ended while a quoted field was still open; the file appears truncated.");
    this.name = "UnterminatedQuoteError";
  }
}

export function parseCsv(rawInput: string): CsvRow[] {
  // Strip a single leading UTF-8 BOM (U+FEFF) before any state-machine work.
  // Excel's "CSV UTF-8" export and Python's `encoding="utf-8-sig"` both
  // prepend one, and when the export also quotes every field (Python's
  // `csv.QUOTE_ALL`), the BOM lands immediately before the header row's
  // opening quote. Handling it anywhere past this point is too late: a BOM
  // character consumed as ordinary field content would mark the field as
  // already started, so the quote right after it would read as a literal
  // character instead of opening the header's quoted section, and the
  // header would never match a known column name.
  const input = rawInput.charCodeAt(0) === 0xfeff ? rawInput.slice(1) : rawInput;

  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // True once a character that is not leading horizontal whitespace has been
  // consumed for the field currently being built, including a quote. RFC
  // 4180 only lets a quote open a quoted section when it is the first
  // substantive character of a field; a quote that shows up after other
  // content is just a literal character in an unquoted field (e.g.
  // `ab"c,d"e` is the two fields `ab"c` and `d"e`, not one field that merges
  // across the comma). A run of plain spaces or tabs before the quote does
  // not count as "other content" here (see the whitespace handling below),
  // so `, "quoted"` still opens a quoted field the way `,"quoted"` does.
  let fieldStarted = false;
  // Tracks whether the current field was opened with a quote, independently
  // of `field.length`. That distinction is what lets a quoted-empty field
  // (`""`) be told apart from "no field was written on this line at all" when
  // deciding whether to flush a trailing row at end of input.
  let fieldWasQuoted = false;
  let sawAnyFieldOnLine = false;
  let i = 0;
  const len = input.length;

  const endField = (): void => {
    row.push(field);
    field = "";
    fieldStarted = false;
    fieldWasQuoted = false;
    sawAnyFieldOnLine = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    sawAnyFieldOnLine = false;
  };

  while (i < len) {
    const ch = input.charAt(i);

    if (inQuotes) {
      if (ch === '"') {
        if (input.charAt(i + 1) === '"') {
          // An escaped quote inside a quoted field: keep one literal quote
          // and step past both characters.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      // `fieldStarted` being false here means every character consumed for
      // this field so far, if any, was leading horizontal whitespace (the
      // branch below is the only place that can add a character without
      // setting `fieldStarted`, and it only does that for space and tab).
      // That whitespace was tentative pending this exact decision, so it is
      // discarded now that a quote has arrived to open the field for real:
      // a space or tab before an opening quote is not part of the quoted
      // value it introduces. This is a distinct case from a quote appearing
      // after genuine content (F7's `ab"c,d"e`), where `fieldStarted` is
      // already true and this branch does not fire, so that quote stays a
      // literal character instead of opening a section. Do not merge the
      // two: one discards insignificant leading padding, the other refuses
      // to let a quote retroactively reinterpret data already written.
      field = "";
      inQuotes = true;
      fieldStarted = true;
      fieldWasQuoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Treat CRLF as one line ending rather than an empty row plus a blank
      // line. A lone \r with no following \n (old Mac OS 9-style line
      // endings) still ends the row here too: this is a deliberate departure
      // from strict RFC 4180, which does not define bare-\r line endings at
      // all, but it is the more useful behavior for a format whose only
      // published producer is OpenOutreach's own CSV writer, and it costs
      // nothing for the CRLF/LF files that actually show up.
      if (input.charAt(i + 1) === "\n") {
        i += 1;
      }
      endRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    // A space or tab does not set `fieldStarted` while nothing but
    // whitespace has been seen yet, so a quote right after it can still open
    // a quoted field (see the branch above). Once any non-whitespace
    // character has set `fieldStarted`, later whitespace just falls through
    // this same line and is appended normally; it cannot unset the flag, so
    // mid-field spaces (e.g. the preserved `"a,   ,b"` whitespace-only
    // field) are unaffected.
    if (ch !== " " && ch !== "\t") {
      fieldStarted = true;
    }
    i += 1;
  }

  if (inQuotes) {
    throw new UnterminatedQuoteError();
  }

  // Without a trailing newline, the last field and row are still pending and
  // need to be flushed. With one, there is nothing left to do — flushing
  // again here would append a spurious empty row. `fieldWasQuoted` matters
  // here too: a trailing `""` with no newline after it has `field.length ===
  // 0`, but it is a real (empty) field that was explicitly written, not the
  // absence of one, so it must still be flushed.
  if (field.length > 0 || fieldWasQuoted || sawAnyFieldOnLine || row.length > 0) {
    endRow();
  }

  return rows;
}
