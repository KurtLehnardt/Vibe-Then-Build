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
});
