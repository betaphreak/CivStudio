import test from "node:test";
import assert from "node:assert/strict";
import { fmtNum, annualize, fmtPct } from "./num.mjs";

test("small figures keep the two decimals they always had", () => {
  assert.equal(fmtNum(0), "0.00");
  assert.equal(fmtNum(3.14159), "3.14");
  assert.equal(fmtNum(999.994), "999.99");
  assert.equal(fmtNum(-12.5), "-12.50");
});

test("the runaway food price never comes out in exponential notation", () => {
  // the whole reason this module exists: (1e30).toFixed(2) is "1e+30" per spec, because toFixed
  // defers to Number::toString at |n| >= 1e21
  assert.equal((1e30).toFixed(2), "1e+30", "…which is what the UI used to print");
  assert.match(fmtNum(1e30), /^[\d.]+e30$/);
  for (const v of [1e21, 1e24, 5.5e28, 1e30, Number.MAX_VALUE])
    assert.ok(!/e\+/.test(fmtNum(v)), `no mantissa-plus-exponent for ${v}: got ${fmtNum(v)}`);
});

test("magnitude suffixes hold three significant digits", () => {
  assert.equal(fmtNum(1000), "1.00K");
  assert.equal(fmtNum(12345), "12.3K");
  assert.equal(fmtNum(999_400), "999K");
  assert.equal(fmtNum(4_560_000), "4.56M");
  assert.equal(fmtNum(7.2e9), "7.20B");
  assert.equal(fmtNum(3.5e12), "3.50T");
  assert.equal(fmtNum(8e15), "8.00Q");
});

test("the suffix ladder hands over to an exponent rather than inventing names", () => {
  assert.equal(fmtNum(1e18), "1.00e18");
  assert.equal(fmtNum(-2.5e20), "-2.50e20");
});

test("a figure the sim could not compute is named, not printed", () => {
  assert.equal(fmtNum(NaN), "NaN");
  assert.equal(fmtNum(Infinity), "∞");
  assert.equal(fmtNum(-Infinity), "-∞");
  assert.equal(fmtNum(null), "—");
  assert.equal(fmtNum(undefined), "—");
});

test("annualize compounds rather than multiplying by 365", () => {
  assert.ok(Math.abs(annualize(0) - 0) < 1e-12);
  // 0.05%/day: 20.0% compounded against 18.25% simple — close, but not the same number
  const small = annualize(0.0005);
  assert.ok(Math.abs(small - 0.2002) < 0.001, `got ${small}`);
  assert.ok(small > 0.0005 * 365, "compounding is the larger of the two for a positive rate");
  // 0.5%/day: the gap is no longer academic
  assert.ok(annualize(0.005) > 5, "517%, not the 183% simple scaling claims");
});

test("annualize handles the degenerate rates without producing nonsense", () => {
  assert.equal(annualize(-1), -1, "everything gone daily is just everything gone");
  assert.equal(annualize(-2), -1);
  assert.ok(Number.isNaN(annualize(NaN)));
  assert.ok(Number.isNaN(annualize(Infinity)));
  assert.ok(annualize(-0.001) < 0 && annualize(-0.001) > -1, "deflation stays a fraction lost");
});

test("percentages read plainly and stay readable when they run away", () => {
  assert.equal(fmtPct(0.125), "12.5%");
  assert.equal(fmtPct(-0.03), "-3.0%");
  assert.equal(fmtPct(0), "0.0%");
  assert.equal(fmtPct(NaN), "—");
  assert.ok(!/e\+/.test(fmtPct(annualize(0.05))), "a compounded rate is big, not unreadable");
});
