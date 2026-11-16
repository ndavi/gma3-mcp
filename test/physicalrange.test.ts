import { test } from "node:test";
import assert from "node:assert/strict";
import { physicalToPercent, percentToPhysical, parsePhysicalSets, dmxOfPhysical, physicalOfDmx, hasPhysicalSpan } from "../src/tools/physicalrange.ts";
import { expectedPercent } from "../src/tools/fixtures.ts";

/**
 * Inverted physical ranges (PhysicalFrom > PhysicalTo): the console's percent follows the ascending physical value
 * (percent = 100 - DMX %), measured on onPC 2.5.1 with the Robin Esprite (Tilt 131.8 -> -131.8) and LEDBeam 350
 * (Tilt 114 -> -114).
 */

const near = (a: number, b: number, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("non-inverted range: percent runs from the first to the second end, unchanged", () => {
  assert.equal(physicalToPercent(0, -270, 270), 50);
  assert.equal(physicalToPercent(-270, -270, 270), 0);
  assert.equal(physicalToPercent(270, -270, 270), 100);
  near(physicalToPercent(-180, -225, 225), 10);
  assert.equal(percentToPhysical(50, -270, 270), 0);
  near(percentToPhysical(10, -225, 225), -180);
});

test("inverted range, Esprite Tilt 131.8 -> -131.8: the console percent follows the ascending physical value", () => {
  // Exact value 77.0751 %; the console read back 77.0865 % (it quantises the DMX value, so +71.40 degrees came out).
  near(physicalToPercent(71.37, 131.8, -131.8), 77.0751, 0.0001);
  near(physicalToPercent(-89.32, 131.8, -131.8), 16.1229, 0.02);
  assert.equal(physicalToPercent(-131.8, 131.8, -131.8), 0);
  assert.equal(physicalToPercent(131.8, 131.8, -131.8), 100);
  assert.equal(physicalToPercent(0, 131.8, -131.8), 50);
  // The reverse conversion, for the percent read back: 22.92 % is -71.39 degrees, 77.0865 % is +71.4.
  near(percentToPhysical(22.92, 131.8, -131.8), -71.39, 0.01);
  near(percentToPhysical(77.0865, 131.8, -131.8), 71.40, 0.01);
  // DMX fraction = (phys - From) / (To - From) = 100 - console percent: valueRaw 3844248 of 16777215 is 22.91 %.
  near(((71.37 - 131.8) / (-131.8 - 131.8)) * 100, 100 - 77.0751, 0.001);
  near((3844248 / 16777215) * 100, 22.91, 0.01);
});

test("inverted range, LEDBeam 350 Tilt 114 -> -114", () => {
  // Exact 81.30 %; the console read back 81.32 % (DMX 18.68 %).
  near(physicalToPercent(71.37, 114, -114), 81.30, 0.01);
  near(percentToPhysical(81.32, 114, -114), 71.37, 0.05);
});

test("inverted range on a non-angle function (Esprite Zoom 50 -> 5)", () => {
  assert.equal(physicalToPercent(5, 50, 5), 0);
  assert.equal(physicalToPercent(50, 50, 5), 100);
  near(physicalToPercent(27.5, 50, 5), 50);
});

test("round trip on inverted and normal ranges", () => {
  for (const [from, to] of [[131.8, -131.8], [-131.8, 131.8], [50, 5], [-270, 270]] as const) {
    for (const p of [-3.2, 0, 12.5, 77.0865, 100]) near(physicalToPercent(percentToPhysical(p, from, to), from, to), p, 1e-9);
  }
});

test("expectedPercent (read-back comparison) uses the console convention for physical, natural and readout units", () => {
  const esprite = { physicalFrom: 131.8, physicalTo: -131.8, readout: "Physical" };
  const want = (unit: "physical" | "natural" | "readout", value: number, row: object) => expectedPercent({ attribute: "Tilt", value, unit }, row as never);
  const a = want("physical", 71.37, esprite) as { percent: number };
  near(a.percent, 77.0751, 0.0001);
  // Within the tool's 0.5 % tolerance of what the console read back (77.0865), not of the DMX-ordered 22.9249.
  assert.ok(Math.abs(a.percent - 77.0865) < 0.5 && Math.abs(a.percent - 22.9249) > 40);
  near((want("natural", 71.37, esprite) as { percent: number }).percent, 77.0751, 0.0001);
  near((want("physical", -89.32, esprite) as { percent: number }).percent, 16.1229, 0.02);
  near((want("physical", 71.37, { physicalFrom: 114, physicalTo: -114, readout: "Physical" }) as { percent: number }).percent, 81.32, 0.05);
  // Non-inverted: unchanged.
  assert.equal((want("physical", 0, { physicalFrom: -270, physicalTo: 270, readout: "Physical" }) as { percent: number }).percent, 50);
  assert.equal((want("physical", 5, { physicalFrom: 0, physicalTo: 10 }) as { percent: number }).percent, 50);
  // Percent units are never converted; an empty range is still refused.
  assert.equal((want("physical", 1, { physicalFrom: 0, physicalTo: 0 }) as { reason: string }).reason.includes("empty"), true);
});

/**
 * Channel sets with their own physical range: Robe Esprite Gobo2Pos (16 bit), function "Gobo2 Pos Index" 0..360 but
 * sets "Gobo indexing min" -180..-1 (DMX 0), "center" 0 (32768), "Gobo indexing max" 1..180 (32769..). Sets read from
 * the Robin Esprite GDTF of the ma3 library (24-bit scale = 16-bit x 256, DmxTo is the next set's start - 1);
 * the 50891 for 100 degrees is the bench measurement of 16/11/2026.
 */
const esprite = () =>
  parsePhysicalSets([
    { name: "", dmxFrom: "000000", physicalFrom: null, physicalTo: null },
    { name: "Gobo indexing min", dmxFrom: "000100", physicalFrom: -180, physicalTo: -1 },
    { name: "Gobo indexing center", dmxFrom: "800000", physicalFrom: 0, physicalTo: 0 },
    { name: "Gobo indexing max", dmxFrom: "800100", physicalFrom: 1, physicalTo: 180 },
  ]);

test("channel sets: the sets' own ranges, not the function's 0..360, give the DMX of a physical value (centred -180..180)", () => {
  const sets = esprite();
  assert.equal(sets.length, 3, "the unnamed set without a physical range is left out");
  assert.equal(hasPhysicalSpan(sets), true);
  assert.equal(sets[1].dmxTo, 0x800100 - 1, "a set without DmxTo ends where the next one starts");
  assert.equal(sets[2].dmxTo, 0xffffff, "the last one ends at the function's end");
  const at100 = dmxOfPhysical(100, sets)!;
  assert.equal(at100.set.name, "Gobo indexing max");
  near(at100.dmx / 256, 50891.5, 1); // bench: DMX 50891
  // The function range (0..360) would give 27.78 %, i.e. DMX 18204: nowhere near.
  assert.ok(Math.abs(at100.dmx / 256 - (100 / 360) * 65535) > 30000);
  assert.equal(dmxOfPhysical(0, sets)!.dmx, 0x800000, "center");
  near(dmxOfPhysical(-100, sets)!.dmx / 256, 14645.5, 1);
  assert.equal(dmxOfPhysical(180, sets)!.dmx, 0xffffff);
  assert.equal(dmxOfPhysical(0.5, sets), null, "between the sets: no range establishes it");
  assert.equal(dmxOfPhysical(200, sets), null);
});

test("channel sets: raw DMX back to physical, and a function without physical spans is not piecewise", () => {
  const sets = esprite();
  near(physicalOfDmx(50891 * 256, sets)!.physical, 99.996, 0.05);
  assert.equal(physicalOfDmx(50891 * 256, sets)!.set.name, "Gobo indexing max");
  assert.equal(physicalOfDmx(0x800000, sets)!.physical, 0);
  assert.equal(hasPhysicalSpan(parsePhysicalSets([{ name: "Open", dmxFrom: "000000", dmxTo: "00FFFF", physicalFrom: 0, physicalTo: 0 }])), false);
  assert.deepEqual(parsePhysicalSets(undefined), []);
  assert.deepEqual(parsePhysicalSets([{ name: "x", dmxFrom: "zz", physicalFrom: 0, physicalTo: 1 }]), [], "an unreadable DMX start is left out");
});
