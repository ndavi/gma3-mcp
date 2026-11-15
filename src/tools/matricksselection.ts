/**
 * Which fixtures of a group a recipe line's MAtricks keeps: the X select of the line's own columns or of the MAtricks
 * object it references, with XWings, XBlock and XGroup. Shared by the coverage prediction of gma3_recipes,
 * gma3_cook_recipes, gma3_edit_recipe and gma3_store_recipe_cues (recipes.ts).
 *
 * Measured on onPC 2.5.1 (show "Rescue", 2026-11-15; docs/tools/recipes.md, "What is and is not verified"):
 * - positions follow the group's stored grid: a group stored 252, 251, 253, 254 with x 1, 0, 2, 3 is read 251, 252,
 *   253, 254 (the selection order); rows (y) do not change it when x is the rank 0 to n - 1;
 * - XWings w, then XBlock b, then XGroup g turn a rank into a position: within a wing (P / w ranks) an even wing counts
 *   up and an odd one down; a block of b neighbours is one position; with XGroup the position is (block mod g);
 * - X k keeps the fixtures whose position is k - 1; X past the last position (XGroup 2 X 3, or 2 blocks and X 4) keeps
 *   none, so the line cooks nothing (no wrap-around).
 * Everything else that might change which fixtures a select keeps is left unpredicted, with the reason: a Y or Z select,
 * XWidth / XShift / XShuffle with a select, inverts and the Mirror transform with a select, Y or Z wings / blocks /
 * groups, wings that do not divide the group, a grid whose x is not the rank 0 to n - 1 (gaps, shared columns) or with
 * several Z layers, an inactive object, and a line that
 * has its own columns and a MAtricks object at the same time.
 */
import type { Gma3Bridge } from "../bridge.js";
import { BridgeError } from "../bridge.js";

export const MATRICKS_AXES = ["X", "Y", "Z"] as const;
export type MatricksAxis = (typeof MATRICKS_AXES)[number];

export interface AxisSettings {
  select: number | null;
  wings: number | null;
  block: number | null;
  group: number | null;
  width: number | null;
  shift: number | null;
  shuffle: number | null;
  phaseFrom: number | null;
  phaseTo: number | null;
  /** Any of XInv, XInvB, XInvG, XInvW, InvertX is on. */
  inverted: boolean;
}

export interface SelectionSettings {
  axes: Record<MatricksAxis, AxisSettings>;
  /** PhaserTransform reads something other than None (Mirror). */
  transform: boolean;
  relativePhase: boolean | null;
  /** The object's Active flag (null on a line or when not read). */
  active: boolean | null;
  /** Properties whose value could not be interpreted, as "Name=value". */
  unparsed: string[];
}

const INT_SUFFIX = { wings: "Wings", block: "Block", group: "Group", width: "Width", shift: "Shift", shuffle: "Shuffle" } as const;
type IntKey = keyof typeof INT_SUFFIX;
const INV_PROPS = (a: MatricksAxis) => [`${a}Inv`, `${a}InvB`, `${a}InvG`, `${a}InvW`, `Invert${a}`];

/** Every property the selection model reads, on a line (its own columns) or a MAtricks object. */
export function selectionProps(): string[] {
  const out: string[] = [];
  for (const a of MATRICKS_AXES) out.push(a, ...Object.values(INT_SUFFIX).map((s) => `${a}${s}`), `PhaseFrom${a}`, `PhaseTo${a}`, ...INV_PROPS(a));
  return [...out, "PhaserTransform", "RelativePhase", "Active"];
}

/** A column as a number: null for None, empty, 0 (an integer setting) or missing; undefined when it cannot be read. */
function numberOf(v: unknown, zeroIsNone: boolean): number | null | undefined {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v === "number") return Number.isFinite(v) ? (zeroIsNone && v === 0 ? null : v) : undefined;
  const s = String(v).trim().replace(/^<(.*)>$/, "$1").trim();
  if (s === "" || /^none$/i.test(s)) return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*°?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return zeroIsNone && n === 0 ? null : n;
}

const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : typeof v === "string" ? (/^(yes|true|on)$/i.test(v.trim()) ? true : /^(no|false|off)$/i.test(v.trim()) ? false : null) : null);

/**
 * The selection settings of a line's fields or a MAtricks object's properties, read with either role (numbers and
 * booleans from asText false, display text from the objects op). `inheritedIsNone`: a value shown as "<n>" comes from
 * the line's MAtricks object, not from the line itself.
 */
export function parseSelectionSettings(fields: Record<string, unknown>, opts: { inheritedIsNone?: boolean } = {}): SelectionSettings {
  const unparsed: string[] = [];
  const read = (prop: string, zeroIsNone: boolean): number | null => {
    const raw = fields[prop];
    if (opts.inheritedIsNone && typeof raw === "string" && /^<.*>$/.test(raw.trim())) return null;
    const n = numberOf(raw, zeroIsNone);
    if (n === undefined) { unparsed.push(`${prop}=${JSON.stringify(raw)}`); return null; }
    return n;
  };
  const axes = {} as Record<MatricksAxis, AxisSettings>;
  for (const a of MATRICKS_AXES) {
    const ints = {} as Record<IntKey, number | null>;
    for (const [k, s] of Object.entries(INT_SUFFIX) as Array<[IntKey, string]>) ints[k] = read(`${a}${s}`, true);
    axes[a] = { select: read(a, true), ...ints, phaseFrom: read(`PhaseFrom${a}`, false), phaseTo: read(`PhaseTo${a}`, false), inverted: INV_PROPS(a).some((p) => flag(fields[p]) === true) };
  }
  const tf = fields.PhaserTransform;
  return {
    axes,
    transform: tf !== undefined && tf !== null && !/^(none|)$/i.test(String(tf).trim()),
    relativePhase: flag(fields.RelativePhase),
    active: flag(fields.Active),
    unparsed,
  };
}

const shaping = (s: AxisSettings) => [s.select, s.wings, s.block, s.group, s.width, s.shift, s.shuffle].some((v) => v !== null);
/** Whether settings hold anything that selects or spreads (a select, wings / blocks / groups..., a phase range). */
export function hasSelectionData(s: SelectionSettings): boolean {
  return MATRICKS_AXES.some((a) => shaping(s.axes[a]) || s.axes[a].phaseFrom !== null || s.axes[a].phaseTo !== null || s.axes[a].inverted) || s.transform;
}

const hasSelect = (s: SelectionSettings) => MATRICKS_AXES.some((a) => s.axes[a].select !== null);

/** "X 1, XGroup 2" */
export function describeSelection(s: SelectionSettings): string {
  const out: string[] = [];
  for (const a of MATRICKS_AXES) {
    const x = s.axes[a];
    if (x.select !== null) out.push(`${a} ${x.select}`);
    for (const [k, suf] of Object.entries(INT_SUFFIX) as Array<[IntKey, string]>) if (x[k] !== null) out.push(`${a}${suf} ${x[k]}`);
  }
  return out.join(", ");
}

export interface GridMember { fixture: string; sfIndex: number; x?: number; y?: number; z?: number }

export type MemberSelection<M extends GridMember> =
  /** No select: every member gets values (wings, blocks... only spread timing and phase). */
  | { kind: "all" }
  | {
      kind: "subset";
      /** The members in selection order (by grid x). */
      ordered: M[];
      kept: M[];
      dropped: M[];
      /** The X position the select keeps (k - 1), and how many X positions there are (null when not known). */
      position: number;
      positions: number | null;
      /** Whether one position holds several fixtures (wings, blocks or groups): the kept fixtures share a phase. */
      shared: boolean;
    }
  | { kind: "unpredicted"; why: string };

/** The members a selection keeps (rules in the module comment). */
export function selectMembers<M extends GridMember>(members: M[], s: SelectionSettings): MemberSelection<M> {
  const { X, Y, Z } = s.axes;
  const where = describeSelection(s);
  const no = (why: string): MemberSelection<M> => ({ kind: "unpredicted", why: where ? `${why} (${where})` : why });
  // An unreadable column might be a select: nothing is assumed.
  if (s.unparsed.length) return no(`MAtricks setting(s) ${s.unparsed.join(", ")} could not be read`);
  if (![X, Y, Z].some((a) => a.select !== null)) return { kind: "all" };
  if (Y.select !== null || Z.select !== null) return no("a Y or Z select is not verified");
  if ([Y, Z].some(shaping)) return no("Y or Z wings, blocks or groups with a select are not verified");
  if (X.width !== null || X.shift !== null || X.shuffle !== null) return no("XWidth, XShift or XShuffle with a select is not verified");
  if (X.inverted || Y.inverted || Z.inverted || s.transform) return no("an invert or the Mirror transform with a select is not verified");
  if (s.active === false) return no("the MAtricks object is not active");
  const k = X.select!;
  if (!Number.isInteger(k) || k < 1) return no(`X ${k} is not a position`);
  const n = members.length;
  if (members.some((m) => typeof m.x !== "number" || typeof m.y !== "number" || typeof m.z !== "number")) return no("the group's grid cells were not read");
  // Rows (y) do not change an X select when x is the rank (Group 9013: x 0-11 on 3 rows keeps what one row keeps).
  if (new Set(members.map((m) => m.z)).size > 1) return no("the group's grid has more than one Z layer; a select on it is not verified");
  const ordered = [...members].sort((a, b) => a.x! - b.x!);
  if (ordered.some((m, i) => m.x !== i)) return no("the group's grid x is not the rank 0 to n - 1 (gaps, or fixtures sharing a column); a select on it is not verified");
  let pos = ordered.map((_, i) => i);
  let count = n;
  const w = X.wings ?? 1;
  if (w > 1) {
    if (n % w !== 0) return no(`XWings ${w} on ${n} fixtures (not a multiple) with a select is not verified`);
    const size = n / w;
    pos = pos.map((i) => (Math.floor(i / size) % 2 === 1 ? size - 1 - (i % size) : i % size));
    count = size;
  }
  const b = X.block ?? 1;
  if (b > 1) {
    pos = pos.map((p) => Math.floor(p / b));
    count = Math.ceil(count / b);
  }
  const g = X.group ?? 1;
  let positions: number | null = count;
  if (g > 1) {
    pos = pos.map((p) => p % g);
    positions = g <= count ? g : null;
  }
  const kept = ordered.filter((_, i) => pos[i] === k - 1);
  const dropped = ordered.filter((_, i) => pos[i] !== k - 1);
  return { kind: "subset", ordered, kept, dropped, position: k - 1, positions, shared: w > 1 || b > 1 || g > 1 };
}

export interface MatricksObjectInfo { exists: boolean; settings?: SelectionSettings; name?: string }

/** A MAtricks object's selection settings, cached per call (exists false when it is not in the show). */
export async function readMatricksSettings(bridge: Gma3Bridge, no: number, t: number, cache: Map<number, MatricksObjectInfo>): Promise<MatricksObjectInfo> {
  const hit = cache.get(no);
  if (hit) return hit;
  let info: MatricksObjectInfo;
  try {
    const res = (await bridge.request("objects", { ref: `MAtricks ${no}`, fields: [...selectionProps(), "Name"], limit: 1 }, t)) as { items?: Array<{ name?: string; invalid?: boolean; fields?: Record<string, unknown> }> };
    const item = res?.items?.[0];
    info = !item || item.invalid ? { exists: false } : { exists: true, name: typeof item.fields?.Name === "string" ? item.fields.Name : item.name, settings: parseSelectionSettings(item.fields ?? {}) };
  } catch (err) {
    if (!(err instanceof BridgeError && /no objects? found|no object at address|path not found/i.test(err.message))) throw err;
    info = { exists: false };
  }
  cache.set(no, info);
  return info;
}

/**
 * The settings that apply to a line: its own columns, or its MAtricks object's when it has one. A line with both its
 * own selection data and an object is not modelled.
 */
export function effectiveSettings(own: SelectionSettings | undefined, object: { no: number; info: MatricksObjectInfo } | null): { settings: SelectionSettings | null; source: string } | { why: string } {
  if (!object) return { settings: own ?? null, source: "the line's own MAtricks columns" };
  if (!object.info.exists || !object.info.settings) return { why: `MAtricks ${object.no} could not be read` };
  if (own && hasSelectionData(own)) {
    // Both spread (wings, blocks, fade...) without a select: every member still gets values.
    if (!hasSelect(own) && !hasSelect(object.info.settings)) return { settings: null, source: `the line's own MAtricks columns and MAtricks ${object.no}` };
    return { why: `the line has its own MAtricks columns (${describeSelection(own) || "phase or invert"}) and MAtricks ${object.no} (${describeSelection(object.info.settings)}); how they combine is not verified` };
  }
  return { settings: object.info.settings, source: `MAtricks ${object.no}${object.info.name ? ` "${object.info.name}"` : ""}` };
}

// ---------------------------------------------------------------------------
// Phase and select (measured on onPC 2.5.1, 2026-11-15)
// ---------------------------------------------------------------------------
//
// A select does not narrow the phase spread. A phase range on the line itself (its own PhaseFromX / PhaseToX, its
// MAtricks object's, or a phaser line's phase) is spread over the X positions of the whole group, in selection order:
// the kept fixtures get the phase of their position, and the fixtures of one position (a block, a group, a wing pair)
// share it (Sequence 9033 cues 6, 9, 10; presets 21.9048-21.9050). A line without a range of its own that calls a phaser
// preset keeps the phases the preset spreads on its own line's group (Sequence 9033 cues 2 and 8).

/** The X phase range of settings (from and to set and different), or null. */
export function phaseRangeOf(s: SelectionSettings | null | undefined): { from: number; to: number } | null {
  const x = s?.axes.X;
  return x && x.phaseFrom !== null && x.phaseTo !== null && x.phaseFrom !== x.phaseTo ? { from: x.phaseFrom, to: x.phaseTo } : null;
}

/** Whether a Y or Z phase range is set (not modelled with a select). */
export function hasOtherPhaseRange(s: SelectionSettings | null | undefined): boolean {
  return !!s && (["Y", "Z"] as const).some((a) => { const x = s.axes[a]; return x.phaseFrom !== null && x.phaseTo !== null && x.phaseFrom !== x.phaseTo; });
}

/**
 * The phase of an X position when a range is spread over `positions` positions: a range of exactly 360 excludes its
 * end (0 / 90 / 180 / 270 on 4), any other keeps both ends (0 / 179.95 / 359.9 on 3).
 */
export function phaseAt(range: { from: number; to: number }, position: number, positions: number): number {
  if (positions <= 1) return range.from;
  const span = range.to - range.from;
  return range.from + (position * span) / (Math.abs(Math.abs(span) - 360) < 1e-9 ? positions : positions - 1);
}

/** Two phases in degrees are the same angle (within 0.05°). */
export function samePhase(a: number, b: number): boolean {
  const d = (((a - b) % 360) + 360) % 360;
  return d < 0.05 || d > 359.95;
}

export const fmtPhase = (p: number) => `${Math.round(p * 100) / 100}°`;
