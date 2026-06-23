// P10.8: radix-tree router — match semantics locked against the old linear one.
import { describe, expect, it } from "vitest";

import { HttpRouter } from "../src/http.js";

const h = (tag: string) => () => tag;

describe("HttpRouter (radix, P10.8)", () => {
  it("matches static routes and misses cleanly", () => {
    const r = new HttpRouter();
    r.add("GET", "/", h("root"));
    r.add("GET", "/health", h("health"));
    expect(r.match("GET", "/")?.handler()).toBe("root");
    expect(r.match("GET", "/health")?.handler()).toBe("health");
    expect(r.match("GET", "/missing")).toBeNull();
    expect(r.match("POST", "/health")).toBeNull(); // method-scoped
  });

  it("extracts and decodes path params", () => {
    const r = new HttpRouter();
    r.add("GET", "/users/:id", h("user"));
    r.add("GET", "/users/:id/posts/:pid", h("post"));
    expect(r.match("GET", "/users/42")?.params).toEqual({ id: "42" });
    expect(r.match("GET", "/users/a%20b")?.params).toEqual({ id: "a b" });
    expect(r.match("GET", "/users/7/posts/9")?.params).toEqual({ id: "7", pid: "9" });
  });

  it("prefers a static segment over a param at the same level", () => {
    const r = new HttpRouter();
    r.add("GET", "/users/:id", h("param"));
    r.add("GET", "/users/me", h("static"));
    expect(r.match("GET", "/users/me")?.handler()).toBe("static");
    expect(r.match("GET", "/users/123")?.handler()).toBe("param");
  });

  it("keeps the first registration on conflict (user routes override later built-ins)", () => {
    const r = new HttpRouter();
    r.add("GET", "/healthz", h("user"));
    r.add("GET", "/healthz", h("builtin")); // added later — must NOT win
    expect(r.match("GET", "/healthz")?.handler()).toBe("user");
    expect(r.size).toBe(1);
  });

  it("does not match a prefix or a longer path than registered", () => {
    const r = new HttpRouter();
    r.add("GET", "/a/b", h("ab"));
    expect(r.match("GET", "/a")).toBeNull(); // intermediate node, no handler
    expect(r.match("GET", "/a/b/c")).toBeNull(); // overruns the trie
  });
});
