import { describe, it, expect } from "vitest";
import { assertSafeBind } from "../src/lib/config.js";

describe("assertSafeBind", () => {
  it("allows loopback addresses", () => {
    expect(() => assertSafeBind("127.0.0.1")).not.toThrow();
    expect(() => assertSafeBind("::1")).not.toThrow();
    expect(() => assertSafeBind("localhost")).not.toThrow();
  });

  it("refuses 0.0.0.0 and public interfaces", () => {
    expect(() => assertSafeBind("0.0.0.0")).toThrow(/loopback|127\.0\.0\.1/i);
    expect(() => assertSafeBind("192.168.1.5")).toThrow();
    expect(() => assertSafeBind("::")).toThrow();
  });
});
