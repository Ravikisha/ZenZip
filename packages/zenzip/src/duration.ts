/** Duration input: milliseconds as a number, or a string like "250ms", "30s", "5m", "2h", "1d". */
export type Duration = number | string;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function ms(input: Duration): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`invalid duration: ${input}`);
    }
    return Math.floor(input);
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(input.trim());
  if (!match) {
    throw new Error(
      `invalid duration "${input}" — expected e.g. 500, "250ms", "30s", "5m", "2h", "1d"`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  return Math.floor(value * UNIT_MS[unit]);
}
