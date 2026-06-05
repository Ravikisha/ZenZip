/** Wildcard event-pattern match — mirrors the Rust implementation:
 * `*` matches one dot-segment, trailing `**` matches any remainder. */
export function eventMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  const p = pattern.split(".");
  const n = name.split(".");
  if (p[p.length - 1] === "**") {
    const prefix = p.slice(0, -1);
    return (
      n.length >= prefix.length &&
      prefix.every((seg, i) => seg === "*" || seg === n[i])
    );
  }
  return p.length === n.length && p.every((seg, i) => seg === "*" || seg === n[i]);
}
