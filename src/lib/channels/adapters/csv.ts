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

export function parseCsv(input: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyFieldOnLine = false;
  let i = 0;
  const len = input.length;

  const endField = (): void => {
    row.push(field);
    field = "";
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

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Treat CRLF as one line ending rather than an empty row plus a blank line.
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
    i += 1;
  }

  // Without a trailing newline, the last field and row are still pending and
  // need to be flushed. With one, there is nothing left to do — flushing
  // again here would append a spurious empty row.
  if (field.length > 0 || sawAnyFieldOnLine || row.length > 0) {
    endRow();
  }

  return rows;
}
