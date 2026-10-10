import { describe, expect, it } from "vitest";
import { UnterminatedQuoteError, parseCsv } from "./csv";

describe("parseCsv", () => {
  it("returns an empty array for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("returns exactly one row for a header-only file with no trailing newline", () => {
    expect(parseCsv("name,email")).toEqual([["name", "email"]]);
  });

  it("returns exactly one row for a header-only file with a trailing newline", () => {
    expect(parseCsv("name,email\n")).toEqual([["name", "email"]]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses a quoted field containing a comma", () => {
    expect(parseCsv('a,"b,c"\n')).toEqual([["a", "b,c"]]);
  });

  it("unescapes a doubled quote inside a quoted field", () => {
    expect(parseCsv('a,"say ""hi"""\n')).toEqual([["a", 'say "hi"']]);
  });

  it("preserves an embedded newline inside a quoted field", () => {
    expect(parseCsv('a,"line1\nline2"\n')).toEqual([["a", "line1\nline2"]]);
  });

  it("parses an empty quoted field between two populated ones", () => {
    expect(parseCsv('a,"",b\n')).toEqual([["a", "", "b"]]);
  });

  it("treats a blank line mid-file as a one-field empty row", () => {
    expect(parseCsv("a\n\nb\n")).toEqual([["a"], [""], ["b"]]);
  });

  it("preserves a whitespace-only field rather than collapsing it", () => {
    expect(parseCsv("a,   ,b\n")).toEqual([["a", "   ", "b"]]);
  });

  it("treats a lone \\r with no following \\n as its own line ending", () => {
    // Deliberate divergence from strict RFC 4180, which does not define a
    // bare \r line ending at all. OpenOutreach's own writer is the only
    // producer this parser has to deal with, and treating a lone \r as a
    // line ending (old Mac OS 9 style) is strictly more permissive than
    // RFC 4180's silence on it, at no cost to the CRLF/LF files that
    // actually show up in practice.
    expect(parseCsv("a\rb\r")).toEqual([["a"], ["b"]]);
  });

  describe("F5: unterminated quote at end of input", () => {
    it("throws UnterminatedQuoteError rather than returning a truncated field", () => {
      expect(() => parseCsv('name,company\n"Jane,Acme')).toThrow(UnterminatedQuoteError);
    });
  });

  describe("F6: a row of only quoted-empty fields is not dropped", () => {
    it("keeps a trailing quoted-empty row with no newline after it", () => {
      expect(parseCsv('name\n""')).toEqual([["name"], [""]]);
    });

    it("agrees with the trailing-newline case (regression pin for the fix above)", () => {
      expect(parseCsv('name\n""\n')).toEqual([["name"], [""]]);
    });
  });

  describe("F7: a quote that is not at the start of a field is a literal character", () => {
    it("does not let a mid-field quote open a quoted section", () => {
      expect(parseCsv('ab"c,d"e')).toEqual([['ab"c', 'd"e']]);
    });
  });

  describe("F1: leading UTF-8 BOM", () => {
    it("strips a BOM before an unquoted header so the header still matches", () => {
      expect(parseCsv("﻿name,email\nJane Doe,jane@acme.com\n")).toEqual([
        ["name", "email"],
        ["Jane Doe", "jane@acme.com"],
      ]);
    });

    it("strips a BOM before a quoted header, which a trim() alone cannot do once the BOM has already made the quote a literal character", () => {
      // Excel's "CSV UTF-8" export and Python's `csv.QUOTE_ALL` with
      // `encoding="utf-8-sig"` both produce exactly this shape: a BOM
      // immediately followed by a quoted header row. Before this fix, the
      // BOM counted as the field's first character, so the header's opening
      // quote read as a literal character instead of opening a quoted
      // section, and the header field came out as `"name"` (quotes
      // retained) rather than `name`.
      expect(parseCsv('﻿"name","email"\r\n"Jane Doe","jane@acme.com"\r\n')).toEqual([
        ["name", "email"],
        ["Jane Doe", "jane@acme.com"],
      ]);
    });
  });

  describe("F2: horizontal whitespace before an opening quote", () => {
    it("lets a space between a comma and a quote still open a quoted field", () => {
      // Before this fix, the space set `fieldStarted`, so the quote right
      // after it was read as a literal character (F7's rule) instead of
      // opening the field. That split the still-open multi-line quoted
      // value across an extra row and fabricated a bogus row out of its
      // second line.
      expect(parseCsv('name, reason\nAda, "likes apples\nand pears"\nBob, "fine"\n')).toEqual([
        ["name", " reason"],
        ["Ada", "likes apples\nand pears"],
        ["Bob", "fine"],
      ]);
    });

    it("still treats a tab before a quote the same way", () => {
      expect(parseCsv('a,\t"b,c"\n')).toEqual([["a", "b,c"]]);
    });

    it("keeps a mid-field quote literal even though leading whitespace before a quote is now tolerated", () => {
      // Regression guard for F7 alongside the F2 fix: real content (not
      // whitespace) before the quote must still make it a literal character.
      expect(parseCsv('ab"c,d"e')).toEqual([['ab"c', 'd"e']]);
    });
  });
});
