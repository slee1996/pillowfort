import { describe, it, expect } from "bun:test";
import { sanitizeStyle, uniqueName, STYLE_COLORS, MAX_NAME_LEN } from "../src/shared";

describe("sanitizeStyle", () => {
  it("returns undefined for null", () => {
    expect(sanitizeStyle(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(sanitizeStyle(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(sanitizeStyle("bold")).toBeUndefined();
    expect(sanitizeStyle(42)).toBeUndefined();
  });

  it("passes through valid { bold: true }", () => {
    expect(sanitizeStyle({ bold: true })).toEqual({ bold: true });
  });

  it("passes through valid color from palette", () => {
    for (const color of STYLE_COLORS) {
      expect(sanitizeStyle({ color })).toEqual({ color });
    }
  });

  it("rejects unknown color strings", () => {
    expect(sanitizeStyle({ color: "#BADCOL" })).toBeUndefined();
    expect(sanitizeStyle({ color: "red" })).toBeUndefined();
    expect(sanitizeStyle({ color: "#FFFFFF" })).toBeUndefined();
  });

  it("rejects non-boolean bold/italic/underline values", () => {
    expect(sanitizeStyle({ bold: "yes" })).toBeUndefined();
    expect(sanitizeStyle({ italic: 1 })).toBeUndefined();
    expect(sanitizeStyle({ underline: "true" })).toBeUndefined();
  });

  it("returns undefined when all fields are invalid (empty result)", () => {
    expect(sanitizeStyle({ bold: false, color: "pink" })).toBeUndefined();
  });

  it("ignores extra/unknown properties", () => {
    expect(sanitizeStyle({ bold: true, fontSize: 24, foo: "bar" })).toEqual({ bold: true });
  });

  it("combines multiple valid fields", () => {
    expect(sanitizeStyle({ bold: true, italic: true, underline: true, color: "#FF0000" }))
      .toEqual({ bold: true, italic: true, underline: true, color: "#FF0000" });
  });
});

describe("uniqueName", () => {
  it("returns base name when not taken", () => {
    expect(uniqueName("alice", new Set())).toBe("alice");
    expect(uniqueName("alice", new Set(["bob"]))).toBe("alice");
  });

  it("returns base2 when base is taken", () => {
    expect(uniqueName("alice", new Set(["alice"]))).toBe("alice2");
  });

  it("returns base3 when both base and base2 are taken", () => {
    expect(uniqueName("alice", new Set(["alice", "alice2"]))).toBe("alice3");
  });

  it("truncates to fit within MAX_NAME_LEN when suffixing", () => {
    const longName = "a".repeat(MAX_NAME_LEN);
    const result = uniqueName(longName, new Set([longName]));
    expect(result.length).toBeLessThanOrEqual(MAX_NAME_LEN);
    expect(result).toBe("a".repeat(MAX_NAME_LEN - 1) + "2");
  });

  it("handles high suffix numbers with long names", () => {
    const base = "a".repeat(MAX_NAME_LEN);
    const taken = new Set([base]);
    for (let i = 2; i <= 10; i++) {
      const suffix = String(i);
      taken.add("a".repeat(MAX_NAME_LEN - suffix.length) + suffix);
    }
    const result = uniqueName(base, taken);
    expect(result.length).toBeLessThanOrEqual(MAX_NAME_LEN);
    expect(result).toBe("a".repeat(MAX_NAME_LEN - 2) + "11");
  });
});
