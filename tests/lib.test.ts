import { describe, expect, test } from "bun:test";
import { ok, err, all, map, andThen, unwrapOr, some, none, fromNullable, isOk } from "../src/lib/result";
import { globToRegExp, matchesAny } from "../src/lib/glob";
import { shQuote } from "../src/lib/sh";

describe("Result", () => {
  test("all collects oks", () => {
    expect(all([ok(1), ok(2)])).toEqual(ok([1, 2]));
  });
  test("all short-circuits on first err", () => {
    expect(all([ok(1), err("x"), err("y")])).toEqual(err("x"));
  });
  test("map / andThen / unwrapOr", () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(andThen(ok(2), (n) => err(`bad ${n}`))).toEqual(err("bad 2"));
    expect(unwrapOr(err("e"), 7)).toBe(7);
    expect(isOk(ok(1))).toBe(true);
  });
  test("Option", () => {
    expect(fromNullable(null)).toEqual(none);
    expect(fromNullable("a")).toEqual(some("a"));
  });
});

describe("glob", () => {
  test("star matches prefix", () => {
    expect(globToRegExp("kb-*").test("kb-doc")).toBe(true);
    expect(globToRegExp("kb-*").test("kbdoc")).toBe(false);
  });
  test("exact + question mark + escaping", () => {
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("a?b").test("axb")).toBe(true);
    expect(matchesAny(["x", "kb-*"], "kb-im")).toBe(true);
    expect(matchesAny([], "anything")).toBe(false);
  });
});

describe("shQuote", () => {
  test("wraps and escapes single quotes", () => {
    expect(shQuote("abc")).toBe("'abc'");
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });
});
