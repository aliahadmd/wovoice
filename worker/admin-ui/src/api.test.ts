import { describe, expect, it } from "vitest";
import { readCookie, safeReturnTo } from "./api";

describe("admin browser security helpers", () => {
  it("allows only local admin return paths", () => {
    expect(safeReturnTo("/admin/users/123?tab=activity")).toBe("/admin/users/123?tab=activity");
    expect(safeReturnTo("https://attacker.example/admin")).toBe("/admin/");
    expect(safeReturnTo("//attacker.example/admin")).toBe("/admin/");
  });

  it("reads the host-only CSRF cookie without decoding unrelated values", () => {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      value: "other=value; __Host-wovoice-admin-csrf=csrf_token_123",
    });
    expect(readCookie("__Host-wovoice-admin-csrf")).toBe("csrf_token_123");
    expect(readCookie("missing")).toBe("");
  });
});
