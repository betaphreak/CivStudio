"use strict";
// Number formatting for anything the SIMULATION produces — pure, and unit-tested (num.test.mjs).
//
// Why this exists: `n.toFixed(2)` is not the safe default it looks like. ECMAScript defines toFixed
// to fall back to Number::toString for |n| ≥ 1e21, so it quietly starts returning EXPONENTIAL
// notation exactly where a runaway figure needs to be legible — the food price rendering as
// "1e+30" in the live vitals is that clause, not a bug in the caller.
//
// And an economy CAN produce those numbers: an empty market ratchets its clearing price without
// bound (see the crown-finances fix), which is precisely the moment a spectator is trying to read
// the number and work out what went wrong. So the rule here is that a figure is ALWAYS readable at
// a glance: two decimals while it is small, a magnitude suffix once it is not, and never a
// mantissa-and-exponent the eye has to decode.
//
// (core.fmtInt stays what it is — grouped digits for counts, which have no scale problem.)

// Short-scale suffixes, the ones a player already reads on a stat line. Past quadrillion the names
// stop being common knowledge, so the ladder continues in scientific-but-spoken form: 1e18 is shown
// as "1.00e18", which is at least honest about being unreadable, rather than pretending "Qi" means
// something. Ordered ascending; index i covers 1000^(i+1).
const SUFFIX = ["K", "M", "B", "T", "Q"];

/**
 * A simulation figure, always legible.
 *
 * Below a thousand: two decimals, as before. From a thousand up: three significant digits and a
 * magnitude suffix (12.3K, 4.56M). Past the named suffixes: a compact exponent form. Non-finite
 * input is named rather than printed — "NaN"/"Infinity" through a formatter reads as a formatting
 * failure, and it is not one; it is the number the sim actually produced, and saying so is the
 * useful thing.
 *
 * @param {number} n the figure
 * @param {number} [decimals=2] decimals to show below the first suffix
 * @returns {string} the formatted figure
 */
export function fmtNum(n, decimals = 2) {
  if (n == null || typeof n !== "number") return "—";
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "∞" : "-∞";
  const neg = n < 0, v = Math.abs(n);
  if (v < 1000) return (neg ? "-" : "") + v.toFixed(decimals);

  let i = -1, scaled = v;
  while (scaled >= 1000 && i < SUFFIX.length - 1) { scaled /= 1000; i++; }
  // still ≥ 1000 with the ladder exhausted → past 1e18, where names stop helping
  if (scaled >= 1000) {
    const exp = Math.floor(Math.log10(v));
    return (neg ? "-" : "") + (v / Math.pow(10, exp)).toFixed(2) + "e" + exp;
  }
  // three significant digits: 999K, 99.9M, 9.87B — the width stays put as the magnitude climbs
  const dp = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return (neg ? "-" : "") + scaled.toFixed(dp) + SUFFIX[i];
}

/**
 * A per-day rate shown as the ANNUAL one it amounts to — what a reader can actually judge. A daily
 * inflation of 0.0003 means nothing on its own; 11.6%/yr means a great deal.
 *
 * Compounded, not multiplied by 365: these are rates that apply to a quantity the previous day's
 * rate already moved, so simple scaling understates a positive rate and overstates a negative one,
 * and the gap is not small at sim rates (0.05%/day is 20% a year simple, 20.0% compounded — but
 * 0.5%/day is 183% simple against 517% compounded).
 *
 * @param {number} daily the per-day rate as a fraction (0.001 = 0.1%/day)
 * @param {number} [days=365] days in the compounding year
 * @returns {number} the equivalent annual rate as a fraction
 */
export function annualize(daily, days = 365) {
  if (typeof daily !== "number" || !Number.isFinite(daily)) return NaN;
  if (daily <= -1) return -1;            // a rate that wipes the base out daily is just "all of it"
  return Math.pow(1 + daily, days) - 1;
}

/**
 * A fraction as a percentage string. Kept beside fmtNum because it has the same job — a percentage
 * that runs away (a compounded annual rate can reach absurd magnitudes honestly) must not turn into
 * exponential notation either, so the big end goes through fmtNum.
 *
 * @param {number} frac the fraction (0.125 → "12.5%")
 * @param {number} [decimals=1] decimals below the suffix threshold
 * @returns {string} the formatted percentage
 */
export function fmtPct(frac, decimals = 1) {
  if (typeof frac !== "number" || Number.isNaN(frac)) return "—";
  const pct = frac * 100;
  if (!Number.isFinite(pct)) return (pct > 0 ? "∞" : "-∞") + "%";
  if (Math.abs(pct) < 1000) return pct.toFixed(decimals) + "%";
  return fmtNum(pct, decimals) + "%";
}
