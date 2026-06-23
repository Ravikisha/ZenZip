// Phase 7.16: SSRF guard.
import { describe, expect, it } from "vitest";

import { assertPublicUrl, isPrivateIp } from "../src/index.js";

describe("isPrivateIp (P7.16)", () => {
  it("flags private / loopback / link-local / metadata ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:10.0.0.1", // v4-mapped private
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe("assertPublicUrl (P7.16)", () => {
  it("rejects internal IP-literal targets", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5:8080/",
      "http://192.168.1.1/",
      "http://[::1]:3000/",
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(/SSRF guard/);
    }
  });

  it("rejects disallowed schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/scheme/);
    await expect(assertPublicUrl("gopher://8.8.8.8/")).rejects.toThrow(/scheme/);
  });

  it("allows a public IP literal", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });

  it("enforces an allowHosts allowlist", async () => {
    await expect(
      assertPublicUrl("https://8.8.8.8/", { allowHosts: ["api.example.com"] }),
    ).rejects.toThrow(/not in allowHosts/);
    // allowPrivate lets a loopback through only when explicitly opted in
    await expect(
      assertPublicUrl("http://127.0.0.1/", { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });
});
