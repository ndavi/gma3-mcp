/**
 * Physical <-> console percent conversion for a channel function's PhysicalFrom..PhysicalTo.
 *
 * The console's percent (`At Absolute Percent`, and the `value` / step `absolute` fields the API reads back) follows
 * the ascending order of the physical value, not the DMX order: percent = (phys - min) / (max - min) x 100 with
 * min = min(From, To) and max = max(From, To). On an inverted range (From > To: Robin Esprite Tilt 131.8 -> -131.8,
 * LEDBeam 350 Tilt 114 -> -114, Esprite Zoom 50 -> 5) that is 100 - DMX %. On a normal range (From < To) it is the
 * usual (phys - From) / (To - From) x 100. Measured on onPC 2.5.1: Esprite Tilt `At Absolute Physical 71.37` outputs
 * +71.4 degrees with `value` 77.0865 % and valueRaw 3844248 (DMX 22.91 %). `At Absolute Physical` itself is exact
 * in physical units whatever the order, so tools send physical values as physical and only convert to compare.
 */

/** Console percent of a physical value. The caller has checked that the range is not empty (`to !== from`). */
export const physicalToPercent = (physical: number, from: number, to: number): number => ((physical - Math.min(from, to)) / Math.abs(to - from)) * 100;

/** Is the range inverted (From > To: Esprite Tilt 131.8 -> -131.8)? False when either end is not a number. */
export const isInvertedRange = (from: unknown, to: unknown): boolean => typeof from === "number" && typeof to === "number" && from > to;

/**
 * Which attributes of a `fixtureAttributes` read have an inverted range, by lower-case name: true (every entry of the name
 * with a real range is inverted), false (none is), null (the entries disagree: unknown). A name with no entry that carries
 * a numeric, non-empty range is left out.
 */
export function invertedAttributes(rows: Array<{ attribute?: string | null; physicalFrom?: number | null; physicalTo?: number | null }> | null | undefined): Map<string, boolean | null> {
  const out = new Map<string, boolean | null>();
  for (const r of rows ?? []) {
    const name = (r.attribute ?? "").toLowerCase();
    if (!name || typeof r.physicalFrom !== "number" || typeof r.physicalTo !== "number" || r.physicalFrom === r.physicalTo) continue;
    const inv = isInvertedRange(r.physicalFrom, r.physicalTo);
    out.set(name, out.has(name) && out.get(name) !== inv ? null : inv);
  }
  return out;
}

/** Physical value of a console percent (the reverse of `physicalToPercent`). */
export const percentToPhysical = (percent: number, from: number, to: number): number => Math.min(from, to) + (percent / 100) * Math.abs(to - from);

// ---------------------------------------------------------------------------
// Channel sets with their own physical range
// ---------------------------------------------------------------------------
//
// A channel function can carry channel sets whose physical ranges do not follow the function's own PhysicalFrom..To.
// Robe Esprite Gobo2Pos, function "Gobo2 Pos Index" (16 bit): the function says 0..360 over the whole channel, but its
// sets are "Gobo indexing min" -180..-1 (DMX 0), "center" 0 (DMX 32768) and "Gobo indexing max" 1..180 (DMX 32769..65535).
// Measured on onPC 2.5.1: `At Absolute Physical 100` outputs DMX 50891 = 32769 + (100 - 1) / (180 - 1) x (65535 - 32769),
// i.e. the console converts a physical value through the channel set that contains it, not through the function range
// (which would give 18204). The function range is therefore only a fallback when no set carries a physical range.

/** A channel set with a physical range, its DMX range in the 24-bit scale the console stores. */
export interface PhysicalSet {
  name: string | null;
  dmxFrom: number;
  dmxTo: number;
  physicalFrom: number;
  physicalTo: number;
}

/** A channel set row as `fixtureAttributes` returns it (24-bit hex strings, numbers or null). */
export interface ChannelSetRow {
  name?: string | null;
  dmxFrom?: string | null;
  dmxTo?: string | null;
  physicalFrom?: number | null;
  physicalTo?: number | null;
}

const hex24 = (text: string | null | undefined): number | null => {
  const m = typeof text === "string" ? text.trim().match(/^[0-9a-fA-F]{1,6}$/) : null;
  return m ? parseInt(m[0], 16) : null;
};

/**
 * Channel sets that carry a physical range, with their 24-bit DMX range. A set without DmxTo ends where the next set
 * starts (or at `functionDmxTo`, default 0xFFFFFF, for the last one). Sets without a numeric physical range, or with
 * an unreadable DMX start, are left out.
 */
export function parsePhysicalSets(rows: ChannelSetRow[] | null | undefined, functionDmxTo?: string | null): PhysicalSet[] {
  const all = (rows ?? []).map((r) => ({ name: r.name ?? null, from: hex24(r.dmxFrom), to: hex24(r.dmxTo), pf: r.physicalFrom, pt: r.physicalTo }));
  const sorted = all.filter((r) => r.from !== null).sort((a, b) => (a.from as number) - (b.from as number));
  const out: PhysicalSet[] = [];
  sorted.forEach((r, i) => {
    if (typeof r.pf !== "number" || typeof r.pt !== "number") return;
    const next = sorted[i + 1]?.from ?? null;
    const end = r.to ?? (next !== null ? next - 1 : (hex24(functionDmxTo) ?? 0xffffff));
    out.push({ name: r.name, dmxFrom: r.from as number, dmxTo: end, physicalFrom: r.pf, physicalTo: r.pt });
  });
  return out;
}

/** Does at least one set span a physical interval (a set with from === to is a single point, like a "center")? */
export const hasPhysicalSpan = (sets: PhysicalSet[]): boolean => sets.some((s) => s.physicalFrom !== s.physicalTo);

const EPS = 1e-9;

/** 24-bit DMX the console outputs for a physical value, through the channel set whose physical range holds it; null when no set does. */
export function dmxOfPhysical(physical: number, sets: PhysicalSet[]): { dmx: number; set: PhysicalSet } | null {
  for (const s of sets) {
    const lo = Math.min(s.physicalFrom, s.physicalTo);
    const hi = Math.max(s.physicalFrom, s.physicalTo);
    if (physical < lo - EPS || physical > hi + EPS) continue;
    if (s.physicalFrom === s.physicalTo) return { dmx: s.dmxFrom, set: s };
    return { dmx: s.dmxFrom + ((physical - s.physicalFrom) / (s.physicalTo - s.physicalFrom)) * (s.dmxTo - s.dmxFrom), set: s };
  }
  return null;
}

/** Physical value of a 24-bit DMX value through the channel set that holds it; null when no set does. */
export function physicalOfDmx(dmx: number, sets: PhysicalSet[]): { physical: number; set: PhysicalSet } | null {
  for (const s of sets) {
    if (dmx < s.dmxFrom || dmx > s.dmxTo) continue;
    if (s.physicalFrom === s.physicalTo || s.dmxTo === s.dmxFrom) return { physical: s.physicalFrom, set: s };
    return { physical: s.physicalFrom + ((dmx - s.dmxFrom) / (s.dmxTo - s.dmxFrom)) * (s.physicalTo - s.physicalFrom), set: s };
  }
  return null;
}
