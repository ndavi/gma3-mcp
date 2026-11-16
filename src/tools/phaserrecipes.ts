/**
 * gma3_edit_phaser_recipe: build phaser recipe lines (PhaserRecipe: group + shape + 2 steps from presets or hard values + MAtricks,
 * speed, phase, measure, step curves, trans and width) in a preset, the way the console's Recipe Editor does, safely
 * and read back.
 *
 * There is no command or property that creates a PhaserRecipe line outside the programmer (onPC 2.5.1, THK migration
 * docs/phaser-recipes.md §3): the first line is built in Edit Recipe mode in the programmer's Part Zero and stored
 * into the target. Console facts this module relies on (live 2026-11-14, §1.5, §1.7, §1.8, §1.10):
 *   - `EditRecipe <target>` switches the mode on for that target; `EditRecipe` without a target toggles it.
 *   - A store made in Edit Recipe mode leaves its target pending; the next `EditRecipe <other target>` opens
 *     "Update last object?". OK updates the pending target with the programmer (an empty programmer wipes its recipe
 *     lines); Cancel aborts the EditRecipe. Sent with Cmd() from the plugin thread that dialog stalls the bridge, so
 *     the bridge queues EditRecipe with CmdIndirect (recipe.editBegin / recipe.editEnd) and the server polls
 *     recipe.editState. A normal store with an empty programmer just before (the target's own empty Store, on a FREE
 *     slot: on an existing phaser preset it wipes the line) clears the pending target. If the dialog opens anyway the
 *     tool presses Cancel, never OK.
 *   - In the mode: `Group G` creates no line; `At Shape S` creates the PhaserRecipe line in Part Zero with the shape's
 *     value sources; `Step n` + `At Preset P.X` sets step n's value source (a second `At Preset` on the same step
 *     replaces it); `MAtricks M` sets the line's MAtricks. `Store Preset P.N /Merge /NoConfirmation` moves the line
 *     into the preset and empties Part Zero. A second `At Shape` on the same group re-shapes that line, it adds none.
 *   - Value sources: a step holds one value source per attribute filter of its shape. Sine and the other plain shapes
 *     have one source without a filter; Flyout (19) and Flyout Inverted (20) have 3 per step, filtered Dimmer
 *     (absolute), Tilt and Pan (relative). `At Preset` in the mode writes the preset into EVERY source of the step (a
 *     Dimmer preset in the Tilt and Pan sources: IntegratedPresetMiss), so a line given per source is built without
 *     `At Preset` and each source is set after the store with `Assign Preset X At <line>.1.<step>.<source>`. The
 *     source's own value (the shape's) comes back when its preset is cleared (`set PRESET ""`), and follows a new
 *     shape of the same layout. Assign Shape does not change a line's value sources (a Flyout line re-shaped to Sine
 *     keeps its 3), so lines 2+ (copies of line 1) and a new shape must have line 1's / the line's layout.
 *   - After the mode is switched off the programmer still holds the phaser's values (it outputs on stage meanwhile);
 *     ClearAll removes them. A line left in Part Zero (an aborted build) is removed by ClearAll too.
 *   - More lines (another family in the same preset): `Copy Preset P.N.1 At Preset P.N.k /NoConfirmation` copies the
 *     first line; `Assign Group|Shape|MAtricks n At Preset P.N.k` and `Assign Preset X At Preset P.N.k.1.<step>.<s>`
 *     retarget it. 21.9001 (All) held a Dimmer line and an RGBW line, 20/20 cooked, each at its own speed.
 *   - The preset's pool does not filter its recipe lines: a Dimmer + RGBW preset in the Dimmer pool (1.9012) and an
 *     RGBW phaser built in Edit Recipe mode in the Position pool (2.9003) cooked completely. The pool is free.
 *   - The line of a preset is `Preset P.N.L`; SPEEDX (BPM), PHASEFROMX, PHASETOX and MEASURE (beats; the cooked
 *     measure reads x100) are its properties. A value source's TRANSX and WIDTHX (percent) are set with `set`; with
 *     Link Steps (the default) the 2 widths of a source keep their sum (Tilt 100/80: step 1 to 90 makes step 2 90).
 *   - Step curve: `Set Preset P.N.L.1.<step>.<s> Property "Curve" "<name>"` from the command line (the Lua `set` of
 *     the property is ignored, and CURVE reads back as an opaque id). With Link Steps a step's curve sets its DECEL and
 *     the next step's ACCEL (Snap also TRANS 0): Linear 0/0, Ease In +100/-100, Ease Out -100/+100, Ease In and Out
 *     -100/-100, Swing +100/+100, Snap 0/0; Snap sets TRANS 0, the others TRANS 100 (Flyout's Dimmer Trans 10 % becomes
 *     100 % with Linear: give trans after a curve to keep another). The cooked steps carry these values.
 *
 *   - Hard values (live 2026-11-15, 21.9070): `Assign Attribute "<Attr>" At <line>.1.1.<s>` sets the source's attribute
 *     for both steps (the Lua `set ATTRIBUTES ""` clears it); `Set <source> Property "ValueAbsolute" | "ValueRelative"
 *     "<v>"` from the command line (the Lua set writes 0), the other layer kept unless set to "None" (RawValueAbs /
 *     RawValueRel). Relative is percent of the attribute's whole range. Own values read raw as numbers, inherited ones
 *     as text ("<<100.00>100.00>"); nothing takes a hard value back to the shape's. Without attribute or preset a line
 *     does not cook.
 *   - Transform and the line's own MAtricks columns (live 2026-11-15, 21.9073 / 21.9074): PHASERTRANSFORM, INVERTSTYLE,
 *     XWINGS / XBLOCK / XGROUP, the Y ones and PHASEFROMY / PHASETOY take a Lua set and read back raw ("None" clears;
 *     only the exact names "Mirror" / "None" are taken; other text is ignored). Mirror sets INVERTSTYLE Pan and XInvW with XWings (YInvW with
 *     YWings; without wings nothing is mirrored); None switches the inverts off. Mirror applies at the cook, on the
 *     attributes INVERTSTYLE names: the second wing cooks hard values without the step preset, absolute 100 - x and
 *     relative -x. A line with a MAtricks object reads these from the object.
 *
 * Release: create builds in a free preset slot in any pool, 1 to 8 lines of exactly 2 steps each. A step is one
 * preset (a shape with one value source), a preset per value source (`sources`, by attribute or number), or hard
 * values on an attribute (absolute / relative); a source without a preset or values keeps the shape's value. set / add_line / remove_line edit an existing phaser preset (below). The
 * cue calls the preset with a standard line.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { presetId, type PresetRead } from "./presets.js";
import { matricksValue } from "./groups.js";
import { readGroup, readLines, type GroupInfo } from "./recipes.js";
import { RECOOK_MODES, parseRecook, recookCallers, type RecookDeps, type RecookReport } from "./phaserrecook.js";
import { asRead, buildResult, commandStep, notRequested, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, finiteNumber, objectName, objectNumber } from "../validate.js";
import { invertedAttributes } from "./physicalrange.js";

const POLL_MS = 150;
const MODE_WAIT_MS = 3000;
const MAX_LINES = 8;
const UPDATE_DIALOG = "Update last object?";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notFound = (err: unknown) => err instanceof BridgeError && /no objects? found|no object at address|path not found/i.test(err.message);

/** The predefined step curves and what each writes, with Link Steps: own DECEL, next step's ACCEL, own TRANS (0 for Snap, 100 for the others). */
export const CURVES = {
  linear: { console: "Linear", decel: 0, nextAccel: 0 },
  ease_in: { console: "Ease In", decel: 100, nextAccel: -100 },
  ease_out: { console: "Ease Out", decel: -100, nextAccel: 100 },
  ease_in_out: { console: "Ease In and Out", decel: -100, nextAccel: -100 },
  swing: { console: "Swing", decel: 100, nextAccel: 100 },
  snap: { console: "Snap", decel: 0, nextAccel: 0, trans: 0 },
} as const;
export type CurveName = keyof typeof CURVES;
/** A step curve to set: a predefined curve, or reset (back to the shape's curve; its values are the shape's, not compared). */
export type CurveChoice = CurveName | "reset";
const CURVE_CHOICES: [CurveChoice, ...CurveChoice[]] = ["reset", ...(Object.keys(CURVES) as CurveName[])];
const curveConsole = (c: CurveChoice) => (c === "reset" ? "Reset" : CURVES[c].console);
const isCurve = (c: unknown): c is CurveChoice => typeof c === "string" && (CURVE_CHOICES as string[]).includes(c);

export interface EditState {
  environment?: string;
  editing: boolean;
  editingRaw?: string;
  partZeroLines: Array<{ index: number; class?: string; name?: string }>;
  modal: false | { class?: string; title?: string; text?: string; buttons?: Array<{ text?: string; enabled?: boolean }> };
  modalError?: string;
  lastCommand?: string;
}

export async function readEditState(bridge: Gma3Bridge, t: number): Promise<EditState> {
  return (await bridge.request("recipe.editState", {}, t)) as EditState;
}

/** Programmer value count, or null when the scan was not complete (then nothing is known). */
async function programmerValues(bridge: Gma3Bridge, t: number): Promise<number | null> {
  const r = (await bridge.request("programmer", { scope: "all", limit: 1 }, t)) as { total?: number; coverage?: { complete?: boolean } };
  return r.coverage?.complete === true && typeof r.total === "number" ? r.total : null;
}

async function exists(bridge: Gma3Bridge, ref: string, t: number): Promise<boolean> {
  try {
    const r = (await bridge.request("objects", { ref, fields: [], limit: 1 }, t)) as { items?: unknown[] };
    return (r.items?.length ?? 0) > 0;
  } catch (err) {
    if (notFound(err)) return false;
    throw err;
  }
}

async function readPreset(bridge: Gma3Bridge, ref: string, t: number): Promise<PresetRead | null> {
  try {
    return (await bridge.request("preset.read", { ref }, t)) as PresetRead;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

/** A numeric property reply ("120.00", "360.00°", "10.0%") compared to the value sent. */
export function numberMatches(sent: number, got: unknown): boolean {
  const n = typeof got === "number" ? got : Number.parseFloat(String(got ?? "").replace(",", "."));
  return Number.isFinite(n) && Math.abs(n - sent) < 0.01;
}

/**
 * A Yes/No property as the console reads it: a boolean when the line sets it itself, "<Yes>" / "<No>" when it comes
 * from the shape (live 2026-11-14: Chase line before and after `set PLAYBACKADAPTIVEMEASURE No`), "Yes" / "No" as text.
 */
export function yesNoOf(v: unknown): { value: boolean; own: boolean } | undefined {
  if (typeof v === "boolean") return { value: v, own: true };
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^(<)?\s*(yes|no)\s*(>)?$/i);
  return m ? { value: m[2].toLowerCase() === "yes", own: !(m[1] && m[3]) } : undefined;
}

/** The adaptive flags of a line or of a shape's recipe (`Shape S.1`). */
interface Flags {
  adaptiveMeasure?: boolean;
  adaptiveWidth?: boolean;
}
async function readShapeFlags(bridge: Gma3Bridge, shape: number, t: number): Promise<Flags> {
  const r = (await bridge.request("objects", { ref: `Shape ${shape}.1`, fields: ["PLAYBACKADAPTIVEMEASURE", "PLAYBACKADAPTIVEWIDTH"], asText: false, limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
  const f = r.items?.[0]?.fields ?? {};
  return { adaptiveMeasure: yesNoOf(f.PLAYBACKADAPTIVEMEASURE)?.value, adaptiveWidth: yesNoOf(f.PLAYBACKADAPTIVEWIDTH)?.value };
}

/** The 16 speed masters' names by number (Master 3.n), read from the masters themselves. */
export async function readMasterNames(bridge: Gma3Bridge, t: number): Promise<Map<number, string>> {
  const r = (await bridge.request("children", { ref: "ShowData.Masters.Speed", fields: ["Name"], limit: 32 }, t)) as ChildList;
  const out = new Map<number, string>();
  for (const it of r.items ?? []) if (typeof it.index === "number") out.set(it.index, String(it.fields?.Name ?? it.name ?? ""));
  return out;
}

/** speed_master checks: every master exists; a master whose name another master has (or no name) is read back by its cooked values only. */
function masterProblems(wanted: number[], names: Map<number, string>): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const n of new Set(wanted)) {
    const name = names.get(n);
    if (name === undefined) problems.push(`speed master ${n} (Master 3.${n}) is not in the show`);
    else if (!name.trim()) warnings.push(`speed master ${n} has no name: the line reads its link by the master's name, so only the cooked values tell it`);
    else {
      const same = [...names.entries()].filter(([m, x]) => m !== n && x.trim().toLowerCase() === name.trim().toLowerCase()).map(([m]) => m);
      if (same.length) warnings.push(`speed master ${n} is named ${JSON.stringify(name)} like master(s) ${same.join(", ")}: the line reads its link by name, so only the cooked values tell them apart`);
    }
  }
  return { problems, warnings };
}

/** A line that follows a master with a Speed X other than 60: the master multiplies Speed X (live 2026-11-14, §3). */
const masterSpeedWarning = (label: string, master: string, speedHz: number | undefined) =>
  speedHz !== undefined && Math.abs(speedHz - 1) > 0.0005
    ? [`${label} follows speed master ${JSON.stringify(master)} with Speed X ${+(speedHz * 60).toFixed(3)} BPM: the master multiplies Speed X (one cycle = Measure x 60 / (Speed X x master / 60) s), so a line that follows a master normally has Speed X 60 (then one cycle = Measure x 60 / master BPM)`]
    : [];

// ---- Inputs.

type PresetRef = { pool: number; number: number };
/**
 * Hard values of a value source on one step, instead of a preset (live 2026-11-15, Rescue 21.9070): `absolute`
 * (VALUEABSOLUTE, percent) and / or `relative` (VALUERELATIVE, percent of the attribute's whole range, not degrees).
 */
interface Hard {
  absolute?: number;
  relative?: number;
}
/**
 * One value source of a step as asked: preset (null: back to the source's own value, the shape's), or hard values on
 * an attribute; trans, width. `attribute` is the source's attribute filter (one per source: it is shared by both
 * steps); null clears it (set only).
 */
interface SourceSpec extends Hard {
  preset?: PresetRef | null;
  attribute?: string | null;
  trans?: number;
  width?: number;
}
interface StepSpec extends Hard {
  /** One preset for the step (pool + number): a shape with one value source. */
  pool?: number;
  number?: number;
  /** A shape with one value source: its attribute (with absolute / relative: hard values instead of a preset). */
  attribute?: string | null;
  /** A preset (and trans / width) per value source, keyed by the source's attribute ("Dimmer") or number ("2"). */
  sources?: Array<{ key: string; spec: SourceSpec }>;
  curve?: CurveChoice;
  /** For every value source of the step that does not set its own. */
  trans?: number;
  width?: number;
}
/**
 * The line's own MAtricks columns this tool writes (live 2026-11-15, Rescue 21.9073: a Lua set, read back raw as a
 * number or "None"; None clears), and phase Y. Phase X is `phase` (PHASEFROMX / PHASETOX).
 */
export const LINE_COLUMNS = { x: { wings: "XWINGS", blocks: "XBLOCK", groups: "XGROUP" }, y: { wings: "YWINGS", blocks: "YBLOCK", groups: "YGROUP" } } as const;
type ColumnProp = "XWINGS" | "XBLOCK" | "XGROUP" | "YWINGS" | "YBLOCK" | "YGROUP" | "PHASEFROMY" | "PHASETOY";
const COLUMN_PROPS: ColumnProp[] = ["XWINGS", "XBLOCK", "XGROUP", "YWINGS", "YBLOCK", "YGROUP", "PHASEFROMY", "PHASETOY"];
/** Per column: a number, null (None), absent (not given / not compared). */
type Columns = Partial<Record<ColumnProp, number | null>>;
/**
 * INVERTSTYLE: which attributes the inverts, and so Mirror, act on (live 2026-11-15, 21.9073: with Pan a Tilt line is
 * not mirrored, with Tilt it is). The console names; a text it does not know is ignored (the previous value stays).
 */
export const INVERT_STYLES = { pan: "Pan", tilt: "Tilt", pan_tilt: "P+T", all: "All" } as const;
type InvertStyle = keyof typeof INVERT_STYLES;
/** The attributes a Mirror line mirrors, per INVERTSTYLE as read (null: any). */
const MIRRORED_ATTRIBUTES: Record<string, string[] | null> = { Pan: ["Pan"], Tilt: ["Tilt"], "P+T": ["Pan", "Tilt"], All: null };

interface LineSpec {
  selection: number;
  shape: number;
  steps: StepSpec[];
  matricks?: number;
  speed?: number;
  phase?: { from: number; to: number };
  measure?: number;
  /** Speed master (1-16) the line follows; null: the line's link cleared (SPEEDMASTEROVERRIDE 0). */
  speedMaster?: number | null;
  /** Adaptive Measure / Adaptive Width of the line (PLAYBACKADAPTIVEMEASURE / PLAYBACKADAPTIVEWIDTH). */
  adaptiveMeasure?: boolean;
  adaptiveWidth?: boolean;
  /** PHASERTRANSFORM: mirror sets Mirror (the console then sets INVERTSTYLE Pan and switches XInvW / YInvW on with the wings). */
  transform?: "none" | "mirror";
  invertStyle?: InvertStyle;
  /** The line's own MAtricks columns and phase Y. */
  columns?: Columns;
}

interface CreateArgs {
  action?: string;
  preset?: unknown;
  name?: unknown;
  lines?: unknown;
  selection?: unknown;
  shape?: unknown;
  steps?: unknown;
  matricks?: unknown;
  speed_bpm?: unknown;
  phase?: unknown;
  measure?: unknown;
  speed_master?: unknown;
  adaptive_measure?: unknown;
  adaptive_width?: unknown;
  transform?: unknown;
  invert_style?: unknown;
  x?: unknown;
  y?: unknown;
  phase_y?: unknown;
  exclusive?: unknown;
  recook?: unknown;
  preview?: unknown;
}

const LINE_FIELDS = ["selection", "shape", "steps", "matricks", "speed_bpm", "phase", "measure", "speed_master", "adaptive_measure", "adaptive_width", "transform", "invert_style", "x", "y", "phase_y"] as const;
const MAX_MASTER = 16;

/**
 * speed_master: a master number, written as a number only (live 2026-11-14: SPEEDMASTEROVERRIDE n links master 3.n and
 * reads its name; 0 clears; "None" reads Speed1 (links master 1), a name links the wrong master, "" is ignored).
 * 0 or null clears the link (returned as null); undefined when invalid (reported).
 */
export function parseSpeedMaster(v: Validator, raw: unknown, at: string): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_MASTER) {
    v.fail(`${at} must be a speed master number 1-${MAX_MASTER} (0 or null clears the line's link), got ${JSON.stringify(raw)}; text is refused: the console reads "None" as master 1 and a name as another master`);
    return undefined;
  }
  return raw === 0 ? null : raw;
}

function parseFlag(v: Validator, raw: unknown, at: string): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  v.fail(`${at} must be true or false`);
  return undefined;
}

/** Whether a step spec sets a width (on the step or on one of its value sources). */
const givesWidth = (s: StepSpec) => s.width !== undefined || (s.sources ?? []).some((x) => x.spec.width !== undefined);

/** The line-level conflicts of the adaptive flags: a measure or a width under the matching adaptive flag the console would ignore. */
function adaptiveConflicts(v: Validator, l: { measure?: number; adaptiveMeasure?: boolean; adaptiveWidth?: boolean; steps?: StepSpec[] }, at: (f: string) => string) {
  if (l.measure !== undefined && l.adaptiveMeasure === true) v.fail(`${at("measure")} and ${at("adaptive_measure")}: true contradict each other: under Adaptive Measure the console sets the measure itself (the number of fixtures or phase positions) and ignores MEASURE`);
  if (l.adaptiveWidth === true && (l.steps ?? []).some(givesWidth)) v.fail(`a width and ${at("adaptive_width")}: true contradict each other: under Adaptive Width the console sets the widths itself (100 / phase positions) and ignores WIDTHX`);
}
const TRANS_RANGE = { min: 0, max: 100 };
const WIDTH_RANGE = { min: 0, max: 1000 };
const ABSOLUTE_RANGE = { min: 0, max: 100 };
const RELATIVE_RANGE = { min: -100, max: 100 };
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** attribute, absolute and relative of a value source (or of a one-source step); reported on `v`. */
function parseHard(v: Validator, o: Record<string, unknown>, where: string, out: SourceSpec | StepSpec) {
  if (o.attribute === null) out.attribute = null;
  else if (o.attribute !== undefined) {
    if (typeof o.attribute === "string" && ATTRIBUTE_NAME.test(o.attribute.trim())) out.attribute = o.attribute.trim();
    else v.fail(`${where}.attribute must be an attribute name such as "Tilt", "Dimmer" or "ColorRGB_B" (null clears the source's attribute in set)`);
  }
  if (o.absolute !== undefined) out.absolute = v.check(() => finiteNumber(`${where}.absolute`, o.absolute, ABSOLUTE_RANGE));
  if (o.relative !== undefined) out.relative = v.check(() => finiteNumber(`${where}.relative`, o.relative, RELATIVE_RANGE));
  const preset = "preset" in out ? out.preset : (out as StepSpec).pool;
  if ((out.absolute !== undefined || out.relative !== undefined) && preset !== undefined && preset !== null)
    v.fail(`${where}: give a preset or hard values (absolute / relative), not both: Assign Preset replaces the source's values`);
}

function parsePhase(v: Validator, raw: unknown, at: string): LineSpec["phase"] {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") {
    v.fail(`${at} must be {from, to} in degrees`);
    return undefined;
  }
  const from = v.check(() => finiteNumber(`${at}.from`, p.from, { min: -36000, max: 36000 }));
  const to = v.check(() => finiteNumber(`${at}.to`, p.to, { min: -36000, max: 36000 }));
  return from !== undefined && to !== undefined ? { from, to } : undefined;
}

/** transform, invert_style, the x / y columns (wings, blocks, groups) and phase_y of a line; reported on `v`. */
function parseMatricksFields(v: Validator, raw: Record<string, unknown>, at: (f: string) => string): Pick<LineSpec, "transform" | "invertStyle" | "columns"> {
  const out: Pick<LineSpec, "transform" | "invertStyle" | "columns"> = {};
  if (raw.transform !== undefined) {
    if (raw.transform === "none" || raw.transform === "mirror") out.transform = raw.transform;
    else v.fail(`${at("transform")} must be "none" or "mirror"`);
  }
  if (raw.invert_style !== undefined) {
    if (typeof raw.invert_style === "string" && Object.hasOwn(INVERT_STYLES, raw.invert_style)) out.invertStyle = raw.invert_style as InvertStyle;
    else v.fail(`${at("invert_style")} must be one of ${Object.keys(INVERT_STYLES).join(", ")}`);
  }
  const cols: Columns = {};
  for (const axis of ["x", "y"] as const) {
    const r = raw[axis];
    if (r === undefined) continue;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      v.fail(`${at(axis)} must be {wings?, blocks?, groups?} (a number; 0 or null: None)`);
      continue;
    }
    for (const [k, val] of Object.entries(r as Record<string, unknown>)) {
      const prop = (LINE_COLUMNS[axis] as Record<string, ColumnProp>)[k];
      if (!prop) {
        v.fail(`${at(axis)}.${k} is not a line column this tool sets (wings, blocks, groups; phase ${axis.toUpperCase()} is ${axis === "x" ? "phase" : "phase_y"})`);
        continue;
      }
      if (val === null) cols[prop] = null;
      else {
        const n = v.check(() => finiteNumber(`${at(axis)}.${k}`, val, { integer: true, min: 0, max: 10000 }));
        if (n !== undefined) cols[prop] = n === 0 ? null : n;
      }
    }
  }
  if (raw.phase_y === null) Object.assign(cols, { PHASEFROMY: null, PHASETOY: null });
  else if (raw.phase_y !== undefined) {
    const p = parsePhase(v, raw.phase_y, at("phase_y"));
    if (p) Object.assign(cols, { PHASEFROMY: p.from, PHASETOY: p.to });
  }
  if (Object.keys(cols).length) out.columns = cols;
  return out;
}
const givesColumns = (l: Pick<LineSpec, "transform" | "invertStyle" | "columns">) => l.transform !== undefined || l.invertStyle !== undefined || l.columns !== undefined;
/** A line with a MAtricks pool object reads its columns from it (21.9056: XWings 2 and Transform Mirror of MAtricks 9008). */
const matricksColumnsProblem = (at: string, matricks: number) =>
  `${at} has MAtricks ${matricks}: a line with a MAtricks object reads its columns, Transform and invert style from it, and writing them on the line is not verified (it might reach the shared object); give the line its own columns and Transform without a MAtricks (gma3_configure_matricks sets an object's columns, not its Transform)`;
/** A wings column given (wings, blocks or groups move the phase positions: Adaptive Measure / Width follow them). */
const movesPositions = (c: Columns | undefined) => !!c && (["XWINGS", "XBLOCK", "XGROUP", "YWINGS", "YBLOCK", "YGROUP"] as const).some((p) => c[p] !== undefined);

function parseSources(v: Validator, raw: unknown, at: string): StepSpec["sources"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) {
    v.fail(`${at} must be an object {Attribute: "P.X" | {preset?, trans?, width?}, ...} with at least one value source (by attribute, e.g. Dimmer, or number, e.g. "2")`);
    return undefined;
  }
  const out: NonNullable<StepSpec["sources"]> = [];
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const k = key.trim();
    const where = `${at}.${k || "(empty)"}`;
    if (!k) {
      v.fail(`${at}: a value source name is empty`);
      continue;
    }
    const spec: SourceSpec = {};
    if (typeof val === "string") Object.assign(spec, { preset: v.check(() => presetId(where, val)) });
    else if (val === null) spec.preset = null;
    else if (typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      for (const f of Object.keys(o)) if (!["preset", "attribute", "absolute", "relative", "trans", "width"].includes(f)) v.fail(`${where}.${f} is not a value source field (preset, attribute, absolute, relative, trans, width)`);
      if (o.preset === null) spec.preset = null;
      else if (o.preset !== undefined) spec.preset = v.check(() => presetId(`${where}.preset`, o.preset));
      parseHard(v, o, where, spec);
      if (o.trans !== undefined) spec.trans = v.check(() => finiteNumber(`${where}.trans`, o.trans, TRANS_RANGE));
      if (o.width !== undefined) spec.width = v.check(() => finiteNumber(`${where}.width`, o.width, WIDTH_RANGE));
    } else {
      v.fail(`${where} must be a preset "P.X", null (the shape's value) or {preset? | attribute? + absolute? / relative?, trans?, width?}`);
      continue;
    }
    if (spec.preset === undefined && "preset" in spec) delete spec.preset; // an invalid preset was reported
    out.push({ key: k, spec });
  }
  return out;
}

/** One step of create / add_line (required: a preset or sources) or of set (everything optional; {} keeps the step). */
function parseStep(v: Validator, s: unknown, at: string, required: boolean): StepSpec {
  const out: StepSpec = {};
  if (s !== undefined && s !== null && (typeof s !== "object" || Array.isArray(s))) {
    v.fail(`${at} must be an object {preset | sources, curve?, trans?, width?}`);
    return out;
  }
  const r = (s ?? {}) as Record<string, unknown>;
  const hardGiven = r.attribute !== undefined || r.absolute !== undefined || r.relative !== undefined;
  if (r.preset !== undefined && r.sources !== undefined) v.fail(`${at}: give preset (a shape with one value source) or sources (a preset per value source), not both`);
  else if (r.sources !== undefined) {
    out.sources = parseSources(v, r.sources, `${at}.sources`);
    if (hardGiven) v.fail(`${at}: with sources, give attribute / absolute / relative inside each value source`);
  } else if (r.preset !== undefined || (required && !hardGiven)) Object.assign(out, v.check(() => presetId(`${at}.preset`, r.preset)) ?? {});
  if (r.sources === undefined) parseHard(v, r, at, out);
  if (r.curve !== undefined) {
    if (isCurve(r.curve)) out.curve = r.curve;
    else v.fail(`${at}.curve must be one of ${CURVE_CHOICES.join(", ")}`);
  }
  if (r.trans !== undefined) out.trans = v.check(() => finiteNumber(`${at}.trans`, r.trans, TRANS_RANGE));
  if (r.width !== undefined) out.width = v.check(() => finiteNumber(`${at}.width`, r.width, WIDTH_RANGE));
  return out;
}

function parseLine(v: Validator, raw: Record<string, unknown>, path: string): LineSpec | undefined {
  const at = (f: string) => (path ? `${path}.${f}` : f);
  const selection = v.check(() => objectNumber(at("selection"), raw.selection, { max: 9999 }));
  const shape = raw.shape === undefined ? 1 : v.check(() => objectNumber(at("shape"), raw.shape, { max: 9999 }));
  const matricks = raw.matricks === undefined ? undefined : v.check(() => objectNumber(at("matricks"), raw.matricks, { max: 9999 }));
  const speed = raw.speed_bpm === undefined ? undefined : v.check(() => finiteNumber(at("speed_bpm"), raw.speed_bpm, { min: 0.01, max: 6000 }));
  const measure = raw.measure === undefined ? undefined : v.check(() => finiteNumber(at("measure"), raw.measure, { min: 0.01, max: 1000 }));
  const phase = raw.phase === undefined ? undefined : parsePhase(v, raw.phase, at("phase"));
  const speedMaster = raw.speed_master === undefined ? undefined : parseSpeedMaster(v, raw.speed_master, at("speed_master"));
  const adaptiveMeasure = raw.adaptive_measure === undefined ? undefined : parseFlag(v, raw.adaptive_measure, at("adaptive_measure"));
  const adaptiveWidth = raw.adaptive_width === undefined ? undefined : parseFlag(v, raw.adaptive_width, at("adaptive_width"));
  const mx = parseMatricksFields(v, raw, at);
  if (matricks !== undefined && givesColumns(mx)) v.fail(matricksColumnsProblem(path || "the line", matricks));
  const steps: StepSpec[] = [];
  const before = v.errors.length;
  if (!Array.isArray(raw.steps) || raw.steps.length !== 2) v.fail(`${at("steps")} must be exactly 2 items [{preset: "P.X"}, {preset: "P.Y"}] or [{sources: {...}}, {sources: {...}}] (2-step phasers only in this release)`);
  else raw.steps.forEach((s, i) => steps.push(parseStep(v, s, `${at("steps")}[${i}]`, true)));
  if (steps.some((s) => s.attribute === null || (s.sources ?? []).some((x) => x.spec.attribute === null))) v.fail(`${at("steps")}: attribute null clears a source's attribute with action set; here leave it out (the source then keeps its shape's filter)`);
  if (steps.length === 2 && steps.every((s) => s.pool !== undefined) && steps[0].pool !== steps[1].pool) v.fail(`${at("steps")}: the 2 steps of a line come from one preset pool (one family per line; another family is another line), not pools ${steps[0].pool} and ${steps[1].pool}`);
  adaptiveConflicts(v, { measure, adaptiveMeasure, adaptiveWidth, steps }, at);
  if (selection === undefined || shape === undefined || steps.length !== 2 || v.errors.length > before) return undefined;
  return { selection, shape, steps, matricks, speed, phase, measure, ...(raw.speed_master !== undefined ? { speedMaster } : {}), ...(adaptiveMeasure !== undefined ? { adaptiveMeasure } : {}), ...(adaptiveWidth !== undefined ? { adaptiveWidth } : {}), ...mx };
}

// ---- Value sources: the layout of a shape or a line, and what a line's steps ask of each source.

/**
 * One value source as the console reads it (raw: TRANSX / WIDTHX in percent). absolute / relative: the source's OWN
 * hard values (VALUEABSOLUTE / VALUERELATIVE read raw as a number); a value inherited from the shape reads as text
 * ("<<100.00>100.00>"), one from a preset as the preset's name, an absent layer "None" or "": those are left out.
 */
export interface SourceDetail extends Hard {
  attribute: string | null;
  preset: PresetRef | null;
  accel?: number;
  decel?: number;
  trans?: number;
  width?: number;
}
/** Per step, its value sources. */
type Layout = SourceDetail[][];

type Handle = { class?: string; index?: number; addr?: string; name?: string } | null;
type ChildList = { total?: number; count?: number; items?: Array<{ class?: string; index?: number; name?: string; fields?: Record<string, unknown> }> };
const handleOf = (v: unknown): Handle => (v && typeof v === "object" ? (v as Handle) : null);
const rawNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** MEASURE reads raw as text ("<< 4.00> 4.00>") and as "4.00" in the display role: its first number. */
const measureOf = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const m = typeof v === "string" ? v.match(/-?\d+(?:[.,]\d+)?/) : null;
  return m ? Number(m[0].replace(",", ".")) : undefined;
};
/** The pool number an object handle points at (the last part of its address), when it has the class asked for. */
const numberOf = (v: unknown, cls: string): number | null => {
  const h = handleOf(v);
  if (!h || h.class !== cls || typeof h.addr !== "string") return null;
  const n = Number(h.addr.split(".").pop());
  return Number.isInteger(n) ? n : null;
};
const presetOf = (v: unknown): PresetRef | null => {
  const h = handleOf(v);
  if (!h || h.class !== "Preset" || typeof h.addr !== "string") return null;
  const parts = h.addr.split(".");
  const pool = Number(parts[parts.length - 2]);
  const number = Number(parts[parts.length - 1]);
  return Number.isInteger(pool) && Number.isInteger(number) ? { pool, number } : null;
};
const attributeOf = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  const h = handleOf(v);
  return h && typeof h.name === "string" && h.name.trim() ? h.name.trim() : null;
};
const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const pkey = (p: PresetRef | null | undefined) => (p === undefined ? "?" : p === null ? "-" : `${p.pool}.${p.number}`);
const sourceName = (layout: Layout, s: number) => layout[0]?.[s]?.attribute ?? `source ${s + 1}`;
const layoutText = (layout: Layout) => (layout[0] ?? []).map((x, s) => x.attribute ?? `source ${s + 1}`).join(", ");
function sameLayout(a: Layout, b: Layout): boolean {
  return a.length === b.length && a.every((st, n) => st.length === b[n].length && st.every((x, s) => (x.attribute ?? "") .toLowerCase() === (b[n][s].attribute ?? "").toLowerCase()));
}

async function childList(bridge: Gma3Bridge, ref: string, fields: string[], t: number): Promise<ChildList> {
  const r = (await bridge.request("children", { ref, fields, asText: false, limit: 100 }, t)) as ChildList;
  if ((r.items?.length ?? 0) < (r.total ?? 0)) throw new Error(`${ref} has ${r.total} children; only ${r.items?.length ?? 0} were read`);
  return r;
}

/** The value sources of every step under `base` (a line `Preset P.N.L`, or a shape's recipe `Shape S.1`); null when it is not in the show. */
async function readLayout(bridge: Gma3Bridge, base: string, t: number): Promise<Layout | null> {
  let steps: ChildList;
  try {
    steps = await childList(bridge, `${base}.1`, [], t);
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
  const out: Layout = [];
  for (let n = 1; n <= (steps.items?.length ?? 0); n++) {
    const src = await childList(bridge, `${base}.1.${n}`, ["ATTRIBUTES", "ACCELX", "DECELX", "TRANSX", "WIDTHX", "Preset", "VALUEABSOLUTE", "VALUERELATIVE"], t);
    out.push(
      (src.items ?? []).map((it) => {
        const f = it.fields ?? {};
        const d: SourceDetail = { attribute: attributeOf(f.ATTRIBUTES), preset: presetOf(f.Preset), accel: rawNumber(f.ACCELX), decel: rawNumber(f.DECELX), trans: rawNumber(f.TRANSX), width: rawNumber(f.WIDTHX) };
        if (!d.preset) {
          const a = rawNumber(f.VALUEABSOLUTE);
          const r = rawNumber(f.VALUERELATIVE);
          if (a !== undefined) d.absolute = a;
          if (r !== undefined) d.relative = r;
        }
        return d;
      }),
    );
  }
  return out;
}

/** What the steps ask of each value source of a layout: preset (undefined: not given), trans, width. */
interface Resolved extends Hard {
  preset?: PresetRef | null;
  /** The source's attribute as given (the same on both steps after resolveSteps); null: cleared (set). */
  attribute?: string | null;
  trans?: number;
  width?: number;
}
const isHard = (h: Hard | undefined): boolean => !!h && (h.absolute !== undefined || h.relative !== undefined);
function resolveSteps(steps: StepSpec[], layout: Layout, label: string, stepsField = "steps"): { res: Resolved[][]; errors: string[] } {
  const errors: string[] = [];
  const res: Resolved[][] = layout.map((st) => st.map(() => ({})));
  steps.forEach((st, n) => {
    const srcs = layout[n];
    if (!srcs) {
      errors.push(`${label} has no step ${n + 1}`);
      return;
    }
    if (st.pool !== undefined) {
      if (srcs.length !== 1)
        errors.push(`${label} step ${n + 1} has ${srcs.length} value sources (${layoutText([srcs])}): give ${stepsField}[${n}].sources {${srcs.map((x, s) => `${x.attribute ?? s + 1}: "P.X"`).join(", ")}} instead of one preset (At Preset puts one preset into every source)`);
      else res[n][0].preset = { pool: st.pool, number: st.number! };
    }
    if (st.attribute !== undefined || isHard(st)) {
      if (srcs.length !== 1) errors.push(`${label} step ${n + 1} has ${srcs.length} value sources (${layoutText([srcs])}): give attribute / absolute / relative in ${stepsField}[${n}].sources`);
      else {
        if (st.attribute !== undefined) res[n][0].attribute = st.attribute;
        if (st.absolute !== undefined) res[n][0].absolute = st.absolute;
        if (st.relative !== undefined) res[n][0].relative = st.relative;
      }
    }
    const given = new Set<number>();
    for (const { key, spec } of st.sources ?? []) {
      const idx = /^\d+$/.test(key) ? (Number(key) >= 1 && Number(key) <= srcs.length ? [Number(key) - 1] : []) : srcs.flatMap((x, s) => (x.attribute && eqi(x.attribute, key) ? [s] : []));
      if (idx.length !== 1) {
        errors.push(idx.length ? `${label} step ${n + 1} has ${idx.length} value sources on ${key}: name them by number (1-${srcs.length})` : `${label} step ${n + 1} has no value source ${JSON.stringify(key)} (its value sources: ${layoutText([srcs])}; by number: 1-${srcs.length})`);
        continue;
      }
      if (given.has(idx[0])) errors.push(`${label} step ${n + 1}: value source ${sourceName([srcs], idx[0])} is given twice`);
      given.add(idx[0]);
      Object.assign(res[n][idx[0]], spec);
    }
    for (const r of res[n]) {
      if (st.trans !== undefined && r.trans === undefined) r.trans = st.trans;
      if (st.width !== undefined && r.width === undefined) r.width = st.width;
    }
  });
  for (let s = 0; s < (res[0]?.length ?? 0); s++) {
    if (res[0][s].width !== undefined && res[1]?.[s]?.width !== undefined)
      errors.push(`${label} ${sourceName(layout, s)}: width given on both steps; with Link Steps the 2 widths of a value source keep their sum, so give the width of one step (the other takes the rest)`);
    // A source's attribute is one for both steps (Assign Attribute on step 1 sets step 2's too, live 2026-11-15).
    const a0 = res[0][s].attribute;
    const a1 = res[1]?.[s]?.attribute;
    if (a0 !== undefined && a1 !== undefined && (a0 === null || a1 === null ? a0 !== a1 : !eqi(a0, a1)))
      errors.push(`${label} ${sourceName(layout, s)}: attribute ${JSON.stringify(a0)} on step 1 and ${JSON.stringify(a1)} on step 2; a value source has one attribute for both steps`);
    const a = a0 !== undefined ? a0 : a1;
    if (a !== undefined) for (const st of res) if (st[s]) st[s].attribute = a;
  }
  return { res, errors };
}

/** Hard values as text: "a25.00", "r-20.00", "a25.00r10.00" (rounded to 0.01: -20 cooks as -19.999998807907). */
const fmt2 = (x: number) => {
  const v = Math.round(x * 100) / 100;
  return (Object.is(v, -0) ? 0 : v).toFixed(2);
};
const hardKey = (h: Hard) => `${h.absolute !== undefined ? `a${fmt2(h.absolute)}` : ""}${h.relative !== undefined ? `r${fmt2(h.relative)}` : ""}`;
const isPresetKey = (k: string) => /^\d+\.\d+$/.test(k);
const isHardKey = (k: string) => /^[ar]-?\d/.test(k);
/** Per step and source, the hard values a line holds (undefined: a preset or the shape's value). */
type HardGrid = Array<Array<Hard | undefined>>;

/**
 * A value source's output, per step: the preset it integrates ("P.N"), its hard values ("a25.00", "r-20.00"), "-" for
 * the source's own value from the shape (any value without a preset), "?" unknown; and its attribute filter.
 */
interface Sig {
  line: number;
  source: number;
  attribute: string | null;
  pair: string;
  /** The line is mirrored (PHASERTRANSFORM Mirror, as read): its values on the mirrored wing, see mirrorMatch. */
  mirror?: MirrorScope;
  /** The line's selection: its Group and MAtricks (null: none). Two lines with the same step presets are a duplicate only on the same selection. */
  selection?: Selection;
  /** The group's members ("sf:<index>" and "fx:<fixture>"), set only on a twin (see scopeTwins): its values are the cooked values on these fixtures. */
  members?: Set<string>;
}
/** A phaser line's selection: the group it acts on and its MAtricks (null: none). */
interface Selection {
  group: number | null;
  matricks: number | null;
}
const selectionText = (x: Selection | undefined) => (x ? `Group ${x.group ?? "?"}${x.matricks !== null ? `, MAtricks ${x.matricks}` : ", no MAtricks"}` : "the same selection");
/**
 * Where a Mirror line's mirrored values may be (live 2026-11-15, Rescue 21.9055 / 21.9073, group 9001 = 251-254, XWings
 * 2): on the second wing the cooked values are hard values without the step preset, absolute 100 - x and relative -x
 * (30 / 60 cooks 70 / 40, relative 10 / -20 cooks -10 / 20), only on the attributes INVERTSTYLE names. Which fixtures
 * form the wing is not predicted: any member of the line's group (by subfixture index, else fixture).
 */
interface MirrorScope {
  members: Set<string>;
  /** The attributes mirrored (INVERTSTYLE as read); null: any. */
  attributes: string[] | null;
  /** The pair as the mirrored wing cooks it: "*" for a preset step (any value without a preset), the mirrored hard key, "-". */
  pair: string;
}
/** A source whose values can be told apart: a step from a preset or from hard values. */
const hasPreset = (g: Sig) => g.pair.split("/").some((p) => p !== "-" && p !== "?");
const usable = (g: Sig) => !g.pair.includes("?") && (hasPreset(g) || g.attribute !== null);
function sigsOf(line: number, presets: Array<Array<PresetRef | null | undefined>>, layout: Layout, hard?: HardGrid, selection?: Selection): Sig[] {
  return (layout[0] ?? []).map((x, s) => ({ line, source: s, attribute: x.attribute, pair: presets.map((st, n) => (!st[s] && isHard(hard?.[n]?.[s]) ? hardKey(hard![n][s]!) : pkey(st[s]))).join("/"), ...(selection ? { selection } : {}) }));
}
/**
 * Two lines' sources that cannot be told apart: the same step presets on the same attribute. A source without any
 * preset (the shape's value, e.g. Pan relative 0 on two Flyout lines) is not one: its values are only checked where
 * a single line can have made them.
 */
const sameSteps = (a: Sig, b: Sig) => usable(a) && usable(b) && hasPreset(a) && hasPreset(b) && a.pair === b.pair && (a.attribute === null || b.attribute === null || eqi(a.attribute, b.attribute));
/** The same group and the same MAtricks (a selection that is not known counts as the same: the strict reading). */
const sameSelection = (a: Sig, b: Sig) => !a.selection || !b.selection || (a.selection.group === b.selection.group && a.selection.matricks === b.selection.matricks);
/**
 * Two lines that cannot be told apart: the same steps on the same selection. The same steps on another group (or
 * MAtricks) are twins, not a duplicate: their cooked values are told apart by the group's fixtures (scopeTwins).
 */
const clash = (a: Sig, b: Sig) => sameSteps(a, b) && sameSelection(a, b);
const twins = (a: Sig, b: Sig) => sameSteps(a, b) && !sameSelection(a, b);
const sigText = (g: Sig) => g.pair.split("/").map((p) => (p === "-" ? "the shape's value" : isHardKey(p) ? hardText(p) : `Preset ${p}`)).join(" / ");
const hardText = (k: string) => k.replace(/^a(-?[\d.]+)/, "absolute $1 ").replace(/r(-?[\d.]+)$/, "relative $1").trim();

type Row = PresetRead["rows"][number];
type RowStep = NonNullable<Row["steps"]>[number] & { absolute?: number | null; relative?: number | null };
const cookedNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** One cooked step as a key: its integrated preset, else its hard values, else "-". */
const rowStepKey = (st: RowStep | undefined) => {
  if (st?.integrated?.pool !== undefined && st?.integrated?.no !== undefined) return `${st.integrated.pool}.${st.integrated.no}`;
  const h: Hard = { absolute: cookedNumber(st?.absolute), relative: cookedNumber(st?.relative) };
  return isHard(h) ? hardKey(h) : "-";
};
const rowPairOf = (r: Row) => (r.stepCount === 2 ? [0, 1].map((i) => rowStepKey(r.steps?.[i] as RowStep | undefined)).join("/") : "?");
/** A sig step against a cooked step: the same preset; the same hard values (and no other layer); "-": any step without a preset. */
const stepMatches = (want: string, got: string) => (want === "-" ? !isPresetKey(got) : want === got);
const straightMatch = (r: Row, g: Sig) => {
  if (!usable(g) || (g.attribute !== null && !eqi(g.attribute, r.attribute))) return false;
  if (g.members && !memberOf(r, g.members)) return false;
  const got = rowPairOf(r).split("/");
  const want = g.pair.split("/");
  return got.length === want.length && want.every((w, i) => stepMatches(w, got[i]));
};
/** A hard step key as the mirrored wing cooks it (absolute 100 - x, relative -x); a preset step: "*"; "-" and "?" unchanged. */
export function mirrorKey(k: string): string {
  if (isPresetKey(k)) return "*";
  const m = k.match(/^(?:a(-?[\d.]+))?(?:r(-?[\d.]+))?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return k;
  return hardKey({ ...(m[1] !== undefined ? { absolute: 100 - Number(m[1]) } : {}), ...(m[2] !== undefined ? { relative: -Number(m[2]) } : {}) });
}
const memberOf = (r: Row, members: Set<string>) => (typeof r.sfIndex === "number" ? members.has(`sf:${r.sfIndex}`) : members.has(`fx:${r.fixture}`));
/** A cooked value of a Mirror line's mirrored wing: a group member, a mirrored attribute, each step its mirrored key ("*" and "-": any step without a preset). */
const mirrorMatch = (r: Row, g: Sig) => {
  const m = g.mirror;
  if (!m || !usable(g) || !memberOf(r, m.members)) return false;
  if (g.attribute !== null && !eqi(g.attribute, r.attribute)) return false;
  if (m.attributes && !m.attributes.some((a) => eqi(a, r.attribute))) return false;
  const got = rowPairOf(r).split("/");
  const want = m.pair.split("/");
  return got.length === want.length && want.every((w, i) => (w === "*" || w === "-" ? !isPresetKey(got[i]) : w === got[i]));
};
/** strict: the step presets or hard values themselves (evidence that the line cooked); otherwise a mirrored value counts too. */
const rowMatches = (r: Row, g: Sig, strict = false) => straightMatch(r, g) || (!strict && mirrorMatch(r, g));
/**
 * Hard relative values on an inverted range (PhysicalFrom > PhysicalTo: Robe Esprite Tilt 131.8 -> -131.8, LEDBeam 350
 * Tilt 114 -> -114). Live 2026-11-16, onPC 2.5.1: a recipe's ValueRelative on such an attribute cooks with the OPPOSITE
 * sign (the recipe reads +13.16, the cooked step -13.16; Tilt only measured, Pan on a normal range is unchanged). The
 * read-back therefore expects the cooked sign the console gives: the cooked relative of a hard step on an inverted
 * attribute is negated back before it is compared with what was asked. Nothing sent to the console changes. The range is
 * read from the fixture's channel function (`fixtureAttributes`, once per fixture type); when it cannot be read the row
 * is compared as it is. An ABSOLUTE hard value is not touched: there is no console measurement for it.
 */
export const INVERTED_RELATIVE_NOTE = (n: number, attrs: string[]) =>
  `${n} cooked hard relative value(s) on ${attrs.join(", ")} sit on an inverted physical range (PhysicalFrom > PhysicalTo): the console cooks a relative value with the opposite sign there (live 2026-11-16), so the read-back expects the sign inverted (recipe +X reads -X). Absolute hard values were not changed (never measured on an inverted range)`;

const hardRelativeStep = (st: { relative?: number | null; integrated?: unknown } | undefined) => typeof st?.relative === "number" && Number.isFinite(st.relative) && !st.integrated;

/** Fold the cooked relative values of the rows whose attribute range is inverted (see above); `inverted` says it per row. */
export function foldInvertedRows(rows: Row[], inverted: (r: Row) => boolean | undefined): { rows: Row[]; folded: number; attributes: string[] } {
  let folded = 0;
  const attributes = new Set<string>();
  const out = rows.map((r) => {
    if (!r.steps?.some(hardRelativeStep) || inverted(r) !== true) return r;
    attributes.add(r.attribute);
    folded++;
    return { ...r, steps: r.steps.map((st) => (hardRelativeStep(st) ? { ...st, relative: -(st.relative as number) } : st)) };
  });
  return { rows: out, folded, attributes: [...attributes] };
}

/** Reads the attribute ranges once per fixture type (or fixture) and folds rows with them; keeps the notes for the result. */
function rangeFolder(bridge: Gma3Bridge, t: number) {
  const cache = new Map<string, Promise<Map<string, boolean | null> | null>>();
  const attrs = new Set<string>();
  let foldedNow = 0;
  const unread = new Set<string>();
  const refOf = (fixture: string) => (/^\d+(\.\d+)*$/.test(fixture) ? `Fixture ${fixture}` : /^Fixture \d/.test(fixture) ? fixture : null);
  const rangesOf = (r: Row) => {
    const ref = refOf(r.fixture);
    if (!ref) return Promise.resolve(null);
    const key = r.fixtureType ?? ref;
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        try {
          const res = (await bridge.request("fixtureAttributes", { ref, limit: 500 }, t)) as { attributes?: Array<{ attribute?: string | null; physicalFrom?: number | null; physicalTo?: number | null }> };
          return invertedAttributes(res.attributes);
        } catch (err) {
          unread.add(`${ref} (${err instanceof Error ? err.message : String(err)})`);
          return null;
        }
      })();
      cache.set(key, p);
    }
    return p;
  };
  return {
    async fold(rows: Row[]): Promise<Row[]> {
      const flags = new Map<string, boolean | null>();
      for (const r of rows) {
        if (!r.steps?.some(hardRelativeStep)) continue;
        const key = `${r.fixtureType ?? r.fixture}|${r.attribute.toLowerCase()}`;
        if (!flags.has(key)) flags.set(key, (await rangesOf(r))?.get(r.attribute.toLowerCase()) ?? null);
      }
      const res = foldInvertedRows(rows, (r) => flags.get(`${r.fixtureType ?? r.fixture}|${r.attribute.toLowerCase()}`) ?? undefined);
      // The count is that of the last read folded (the read-back's); the attributes accumulate.
      foldedNow = res.folded || foldedNow;
      for (const a of res.attributes) attrs.add(a);
      return res.rows;
    },
    /** Warnings: the inverted-range note (when a row was folded), plus the fixtures whose range could not be read (their relative values are compared as they are). */
    finish(): string[] {
      return [...(foldedNow ? [INVERTED_RELATIVE_NOTE(foldedNow, [...attrs])] : []), ...(unread.size ? [`the physical range could not be read for ${[...unread].join("; ")}: their cooked relative values were compared as they are (an inverted Tilt cooks with the opposite sign)`] : [])];
    },
  };
}

/** The sig of `mine` a row belongs to: its own values first; a mirrored value only when no other line's own values match it. */
const ownerSig = (r: Row, mine: Sig[], others: Sig[]) => mine.find((g) => straightMatch(r, g)) ?? (others.some((h) => straightMatch(r, h)) ? undefined : mine.find((g) => mirrorMatch(r, g)));
/** The sigs of a line made mirror-aware when the line reads PHASERTRANSFORM Mirror (members read once per group). */
async function withMirror(bridge: Gma3Bridge, t: number, sigs: Sig[], line: { group: number | null; transform?: string; invertStyle?: string } | undefined, groups: Map<number, GroupInfo>): Promise<Sig[]> {
  if (!line || line.transform !== "Mirror" || line.group === null) return sigs;
  const g = await readGroup(bridge, line.group, t, groups);
  const members = new Set(g.members.flatMap((m) => [`sf:${m.sfIndex}`, `fx:${m.fixture}`]));
  const attributes = line.invertStyle !== undefined && Object.hasOwn(MIRRORED_ATTRIBUTES, line.invertStyle) ? MIRRORED_ATTRIBUTES[line.invertStyle] : null;
  return sigs.map((x) => ({ ...x, mirror: { members, attributes, pair: x.pair.split("/").map(mirrorKey).join("/") } }));
}
/**
 * The sigs of lines that have twins (the same steps on another group or MAtricks) get their group's members: a cooked
 * value then belongs to the line whose group holds its fixture. Twins on the very same fixtures (the same group with
 * another MAtricks, or groups that overlap) stay ambiguous: returned as the pairs of lines that cannot be told apart
 * (their values are checked as a whole, not per line). Sigs are updated in place; `all` holds every line's sigs once.
 */
async function scopeTwins(bridge: Gma3Bridge, t: number, all: Sig[], groups: Map<number, GroupInfo>): Promise<string[]> {
  const ambiguous = new Set<string>();
  const members = new Map<Sig, Set<string> | null>();
  const membersOf = async (g: Sig) => {
    if (!members.has(g)) {
      const n = g.selection?.group;
      const info = typeof n === "number" ? await readGroup(bridge, n, t, groups) : undefined;
      members.set(g, info?.exists && !info.truncated && !info.unreadable ? new Set(info.members.flatMap((m) => [`sf:${m.sfIndex}`, `fx:${m.fixture}`])) : null);
    }
    return members.get(g)!;
  };
  for (const g of all) {
    const others = all.filter((h) => h.line !== g.line && twins(g, h));
    if (!others.length) continue;
    const mine = await membersOf(g);
    if (!mine) {
      ambiguous.add(`lines ${[g.line, ...others.map((h) => h.line)].sort((a, b) => a - b).join(" and ")}`);
      continue;
    }
    g.members = mine;
    for (const h of others) {
      const theirs = await membersOf(h);
      if (!theirs || [...mine].some((x) => theirs.has(x))) ambiguous.add(`lines ${[g.line, h.line].sort((a, b) => a - b).join(" and ")}`);
    }
  }
  return [...ambiguous];
}
const ambiguousNote = (pairs: string[]) => `${pairs.join("; ")}: the same step presets on selections that share fixtures (the same group with another MAtricks, or overlapping groups): their cooked values cannot be told apart per line, so speed, curves, trans and width of those values are not compared per line`;

const rowKey = (r: Row) => `${r.fixture}|${r.attribute}|${rowPairOf(r)}|${r.speed}|${r.measure}|${r.cooked}|${(r.steps ?? []).map((s) => `${s.accel},${s.decel},${s.trans},${s.width}`).join(";")}`;
const counts = (rows: Row[]) => rows.reduce((m, r) => m.set(rowKey(r), (m.get(rowKey(r)) ?? 0) + 1), new Map<string, number>());
const near = (a: number | undefined, b: number | undefined, tol: number) => b === undefined || (a !== undefined && Math.abs(a - b) < tol);

/**
 * The value-source rules shared by create and the edits: each source's 2 presets from one pool, a source without an
 * attribute filter needs a preset, the line has a source from a preset, and a source's preset holds its attribute.
 */
function sourceProblems(label: string, presets: Array<Array<PresetRef | null | undefined>>, layout: Layout, target: PresetRef, presetRows: Map<string, Row[]>, hard?: HardGrid): string[] {
  const p: string[] = [];
  const single = layout.every((st) => st.length === 1);
  const sigs = sigsOf(0, presets, layout, hard);
  for (const g of sigs) {
    const ps = presets.map((st) => st[g.source]).filter((x): x is PresetRef => !!x);
    if (ps.length === 2 && ps[0].pool !== ps[1].pool)
      p.push(single ? `the 2 steps of a line come from one preset pool (one family per line; another family is another line), not pools ${ps[0].pool} and ${ps[1].pool}` : `${label} ${sourceName(layout, g.source)}: the 2 steps of a value source come from one preset pool, not pools ${ps[0].pool} and ${ps[1].pool}`);
    if (ps.some((x) => x.pool === target.pool && x.number === target.number)) p.push("a step preset cannot be the target preset itself");
    // Without an attribute or a preset the line does not cook (live 2026-11-15): hard values need the source's attribute.
    if (g.attribute === null && g.pair.split("/").some(isHardKey)) p.push(`${label} value source ${g.source + 1} has hard values but no attribute: give its attribute (e.g. "Tilt"); without an attribute or a preset the line does not cook`);
    else if (!hasPreset(g) && g.attribute === null && !g.pair.includes("?")) p.push(`${label} value source ${g.source + 1} has no attribute filter: it needs a preset, or an attribute with hard values (its values could not be told apart)`);
    if (g.attribute)
      presets.forEach((st, n) => {
        const x = st[g.source];
        if (!x) return;
        const rows = presetRows.get(pkey(x));
        if (rows && !rows.some((r) => eqi(r.attribute, g.attribute!))) p.push(`${label} step ${n + 1} ${g.attribute}: Preset ${pkey(x)} holds no ${g.attribute} value (it would not cook: IntegratedPresetMiss)`);
      });
  }
  if (!sigs.some(hasPreset)) p.push(`${label} has no value source from a preset or hard values: its values could not be told apart`);
  return [...new Set(p)];
}

/** The layout a line will have: its shape's (or its own), with each source's attribute as given (null: cleared). */
const effectiveLayout = (layout: Layout, res: Resolved[][]): Layout =>
  layout.map((st, n) => st.map((x, s) => ({ ...x, attribute: res[n]?.[s]?.attribute !== undefined ? res[n][s].attribute! : x.attribute })));
/** The attributes the steps name (once each). */
const givenAttributes = (steps: StepSpec[]) => [
  ...new Set(steps.flatMap((s) => [s.attribute, ...(s.sources ?? []).map((x) => x.spec.attribute)]).filter((a): a is string => typeof a === "string")),
];
/** Attributes the show does not define (Assign Attribute would answer "Illegal object", live 2026-11-15). */
async function missingAttributes(bridge: Gma3Bridge, names: string[], t: number): Promise<string[]> {
  const out: string[] = [];
  for (const a of new Set(names)) if (!(await exists(bridge, `ShowData.LivePatch.AttributeDefinitions.Attributes.${a}`, t))) out.push(`attribute ${JSON.stringify(a)}`);
  return out;
}
/** A source the shape filters on an attribute keeps that filter: another attribute, or clearing it, is refused. */
function attributeProblems(label: string, shapeLayout: Layout, res: Resolved[][]): string[] {
  return (shapeLayout[0] ?? []).flatMap((x, s) => {
    const a = res[0]?.[s]?.attribute;
    if (a === undefined || x.attribute === null || (a !== null && eqi(a, x.attribute))) return [];
    return [`${label} value source ${s + 1} is filtered on ${x.attribute} by its shape: ${a === null ? "its attribute cannot be cleared" : `it cannot take attribute ${a}`} (another attribute is a line of its own, on a shape with one value source)`];
  });
}
/**
 * The attributes and hard values a line's sources must read (as resolved; a hard source reads only the layers given,
 * the other is None), compared with its value sources as read.
 */
function hardDiff(label: string, got: { steps: Array<{ sources: SourceDetail[] }> } | undefined, eff: Layout, res: Resolved[][]): string[] {
  if (!got) return [];
  const p: string[] = [];
  res.forEach((st, n) =>
    st.forEach((r, s) => {
      const g = got.steps[n]?.sources[s];
      if (!g) return;
      const at = `${label} step ${n + 1} ${sourceName(eff, s)}`;
      const want = eff[n]?.[s]?.attribute ?? null;
      if (r.attribute !== undefined && (want === null || g.attribute === null ? want !== g.attribute : !eqi(want, g.attribute))) p.push(`${at} attribute reads ${g.attribute ?? "none"}, ${want ?? "none"} expected`);
      if (!isHard(r)) return;
      for (const k of ["absolute", "relative"] as const) {
        const w = r[k];
        if (w === undefined ? g[k] !== undefined : !near(g[k], w, 0.01) || g[k] === undefined) p.push(`${at} ${k} reads ${g[k] ?? "none"}, ${w ?? "none"} expected`);
      }
      if (g.preset) p.push(`${at} still holds Preset ${pkey(g.preset)}`);
    }),
  );
  return p;
}
/** The hard values the resolved steps give. */
const hardOf = (res: Resolved[][]): HardGrid => res.map((st) => st.map((r) => (isHard(r) ? { ...(r.absolute !== undefined ? { absolute: r.absolute } : {}), ...(r.relative !== undefined ? { relative: r.relative } : {}) } : undefined)));

/**
 * The commands that put hard values into a value source (live 2026-11-15, Rescue 21.9070): from the command line only
 * (the Lua set of VALUEABSOLUTE / VALUERELATIVE writes 0); a source keeps its other layer unless it is set to None
 * (RawValueAbs / RawValueRel "None"), so the layer not given is cleared. A preset on the source is cleared first.
 */
function hardActions(src: string, h: Hard, hadPreset: boolean): Action[] {
  const cmd = (command: string): Action => ({ kind: "cmd", command });
  const set = (p: string, v: string) => cmd(`Set ${src} Property "${p}" "${v}"`);
  return [
    ...(hadPreset ? [{ kind: "set", ref: src, property: "PRESET", value: "", expect: "empty" } as Action] : []),
    ...(h.absolute !== undefined ? [set("ValueAbsolute", String(h.absolute))] : [set("RawValueAbs", "None")]),
    ...(h.relative !== undefined ? [set("ValueRelative", String(h.relative))] : [set("RawValueRel", "None")]),
  ];
}
/** The command that sets (or, null, clears) a source's attribute; it applies to both steps of the source. */
const attributeAction = (src: string, a: string | null): Action => (a === null ? { kind: "set", ref: src, property: "ATTRIBUTES", value: "", expect: "empty" } : { kind: "cmd", command: `Assign Attribute "${a}" At ${src}` });

/** Step presets per step and source, as the line will hold them: given, else the base (a kept or copied source), else the shape's value. */
const presetsOf = (res: Resolved[][], base?: Array<Array<PresetRef | null | undefined>>, clearMissing = false) =>
  res.map((st, n) => st.map((r, s) => (r.preset !== undefined ? r.preset : clearMissing || !base ? null : base[n]?.[s])));

type Action =
  | { kind: "cmd"; command: string }
  | { kind: "set"; ref: string; property: string; value: string; expect: "number" | "empty" }
  /** A Yes/No property (the adaptive flags), read back as Yes/No. */
  | { kind: "set"; ref: string; property: string; value: "Yes" | "No"; expect: "yesno" }
  /** SPEEDMASTEROVERRIDE: written as a number, read back as the master's name ("" when cleared). */
  | { kind: "set"; ref: string; property: string; value: string; expect: "text"; text: string }
  /** A MAtricks column or phase Y: read back as a number, "90°" or "None" (want null). */
  | { kind: "set"; ref: string; property: string; value: string; expect: "column"; column: "int" | "phase"; want: number | null };
const actionText = (a: Action) => (a.kind === "cmd" ? a.command : `set ${a.ref} ${a.property}=${a.value === "" ? '""' : a.value}`);

async function runAction(bridge: Gma3Bridge, name: string, a: Action, t: number): Promise<StepResult> {
  if (a.kind === "cmd") return commandStep(bridge, name, a.command, t);
  try {
    const r = (await bridge.request("set", { ref: a.ref, property: a.property, value: a.value }, t)) as { value?: unknown; readOk?: boolean };
    const empty = r?.value === "" || r?.value === null || r?.value === undefined;
    const good =
      a.expect === "empty" ? empty && r?.readOk !== false
      : a.expect === "yesno" ? yesNoOf(r?.value)?.value === (a.value === "Yes")
      : a.expect === "text" ? (a.text === "" ? empty : String(r?.value ?? "").trim() === a.text.trim()) && r?.readOk !== false
      : a.expect === "column" ? columnMatches(a.want, matricksValue(a.column, r?.value))
      : numberMatches(Number(a.value), r?.value);
    const wanted = a.expect === "text" ? ` (${a.text === "" ? "no master" : JSON.stringify(a.text)} expected)` : "";
    return { name, status: good ? "succeeded" : "failed", op: "set", detail: { ref: a.ref, property: a.property }, ...(good ? {} : { error: `${a.ref} ${a.property} reads ${JSON.stringify(r?.value)} after writing ${a.value === "" ? '""' : a.value}${wanted}` }) };
  } catch (err) {
    return stepFromError(name, err, { op: "set" });
  }
}

/** A column as read (a number, null for None, undefined unreadable) against the one asked. */
const columnMatches = (want: number | null, got: number | null | undefined) => (want === null ? got === null : typeof got === "number" && Math.abs(got - want) < 0.01);

/** Trans and width of each source (widths first: with Link Steps a width moves the other step's). */
function sourceSettings(at: (step: number, source: number) => string, res: Resolved[][]): Action[] {
  const set = (prop: "WIDTHX" | "TRANSX", key: "width" | "trans") => res.flatMap((st, n) => st.flatMap((r, s): Action[] => (r[key] !== undefined ? [{ kind: "set", ref: at(n + 1, s + 1), property: prop, value: String(r[key]), expect: "number" }] : [])));
  return [...set("WIDTHX", "width"), ...set("TRANSX", "trans")];
}

/** The adaptive flags a line's own settings write: a measure switches Adaptive Measure off (the console ignores MEASURE under it). */
const explicitFlags = (l: LineSpec): Flags => ({ adaptiveMeasure: l.measure !== undefined ? false : l.adaptiveMeasure, adaptiveWidth: l.adaptiveWidth });

/**
 * create: the adaptive flags line i has before its own settings. Line 1 has its shape's; a line 2+ is a copy of line 1
 * after line 1's settings: a flag line 1 set itself is kept through Assign Shape, another one follows the line's shape.
 */
function predictFlags(specs: LineSpec[], i: number, shapes: Map<number, Flags>): Flags {
  const first = specs[0];
  const s1 = shapes.get(first.shape) ?? {};
  if (i === 0) return s1;
  const e1 = explicitFlags(first);
  const own = specs[i].shape === first.shape ? s1 : (shapes.get(specs[i].shape) ?? {});
  return { adaptiveMeasure: e1.adaptiveMeasure ?? own.adaptiveMeasure, adaptiveWidth: e1.adaptiveWidth ?? own.adaptiveWidth };
}

/** create: the flags and master line i must read after the build (undefined: not compared). */
function expectedLine(specs: LineSpec[], i: number): { flags: Flags; master: number | null | undefined } {
  const e = explicitFlags(specs[i]);
  const e1 = explicitFlags(specs[0]);
  return {
    flags: { adaptiveMeasure: e.adaptiveMeasure ?? (i > 0 ? e1.adaptiveMeasure : undefined), adaptiveWidth: e.adaptiveWidth ?? (i > 0 ? e1.adaptiveWidth : undefined) },
    master: specs[i].speedMaster !== undefined ? specs[i].speedMaster : i > 0 ? specs[0].speedMaster : undefined,
  };
}

/**
 * create: the Transform fields line i must read. A line 2+ is a copy of line 1 and keeps what line 1 set unless it sets
 * it itself (a new MAtricks object replaces the columns: not compared). Mirror sets INVERTSTYLE Pan (a style given is
 * written after it); the inverts follow from the transform and the wings. A field nobody set is not compared.
 */
function expectedTransform(specs: LineSpec[], i: number): TransformFields {
  const own = specs[i];
  const from = i > 0 && own.matricks === undefined ? specs[0] : undefined;
  const pick = <T>(f: (l: LineSpec) => T | undefined): T | undefined => f(own) ?? (from ? f(from) : undefined);
  const t = pick((l) => l.transform);
  const transform = t === undefined ? undefined : t === "mirror" ? "Mirror" : "None";
  const columns: Columns = {};
  for (const p of COLUMN_PROPS) {
    const c = own.columns?.[p] !== undefined ? own.columns[p] : from?.columns?.[p];
    if (c !== undefined) columns[p] = c;
  }
  const styleOf = (l: LineSpec | undefined) => (!l ? undefined : l.invertStyle ? INVERT_STYLES[l.invertStyle] : l.transform === "mirror" ? "Pan" : undefined);
  const invertStyle = styleOf(own) ?? (own.transform === undefined ? styleOf(from) : undefined);
  return { transform, invertStyle, ...derivedInverts(transform, columns), columns };
}
/** A Mirror line without X or Y wings mirrors nothing (live 2026-11-15, 21.9073: XWings None, the 4 fixtures cooked alike, XInvW No). */
const mirrorWithoutWings = (label: string, e: TransformFields) =>
  e.transform === "Mirror" && !e.columns?.XWINGS && !e.columns?.YWINGS
    ? [`${label} has Transform Mirror without X or Y wings on the line: Mirror mirrors along the wings (it switches XInvW / YInvW on with them), so nothing is mirrored (live: XWings None, every fixture cooked alike); give x: {wings: 2}`]
    : [];

/**
 * A line's settings in order: SPEEDX, PHASEFROMX / PHASETOX, the adaptive flags (before MEASURE, and before the widths
 * which are set later), MEASURE, SPEEDMASTEROVERRIDE (a number; read back as the master's name). Adaptive Measure is
 * switched off for a measure when the line has it on (or it is not known).
 */
function lineSettings(ref: string, l: Pick<LineSpec, "speed" | "phase" | "measure" | "speedMaster" | "adaptiveMeasure" | "adaptiveWidth" | "transform" | "invertStyle" | "columns">, names: Map<number, string>, before: Flags): Action[] {
  const num = (property: string, value: number): Action => ({ kind: "set", ref, property, value: String(value), expect: "number" });
  const flag = (property: string, on: boolean): Action => ({ kind: "set", ref, property, value: on ? "Yes" : "No", expect: "yesno" });
  const out: Action[] = [];
  if (l.speed !== undefined) out.push(num("SPEEDX", l.speed));
  if (l.phase) out.push(num("PHASEFROMX", l.phase.from), num("PHASETOX", l.phase.to));
  // The columns and phase Y, then Transform (it switches the wings' inverts on and sets INVERTSTYLE Pan), then the style.
  for (const p of COLUMN_PROPS) {
    const want = l.columns?.[p];
    if (want !== undefined) out.push({ kind: "set", ref, property: p, value: want === null ? "None" : String(want), expect: "column", column: p.startsWith("PHASE") ? "phase" : "int", want });
  }
  if (l.transform) {
    const tr = l.transform === "mirror" ? "Mirror" : "None";
    out.push({ kind: "set", ref, property: "PHASERTRANSFORM", value: tr, expect: "text", text: tr });
  }
  if (l.invertStyle) out.push({ kind: "set", ref, property: "INVERTSTYLE", value: INVERT_STYLES[l.invertStyle], expect: "text", text: INVERT_STYLES[l.invertStyle] });
  if (l.measure !== undefined ? before.adaptiveMeasure !== false : l.adaptiveMeasure !== undefined) out.push(flag("PLAYBACKADAPTIVEMEASURE", l.measure !== undefined ? false : l.adaptiveMeasure!));
  if (l.adaptiveWidth !== undefined) out.push(flag("PLAYBACKADAPTIVEWIDTH", l.adaptiveWidth));
  if (l.measure !== undefined) out.push(num("MEASURE", l.measure));
  if (l.speedMaster !== undefined) out.push({ kind: "set", ref, property: "SPEEDMASTEROVERRIDE", value: String(l.speedMaster ?? 0), expect: "text", text: l.speedMaster === null ? "" : (names.get(l.speedMaster) ?? "") });
  return out;
}

const pair = (l: LineSpec) => (l.steps.every((s) => s.pool !== undefined) ? l.steps.map((s) => `${s.pool}.${s.number}`).join("/") : null);
const stepPresets = (l: LineSpec) => l.steps.flatMap((s) => [...(s.pool !== undefined ? [{ pool: s.pool, number: s.number! }] : []), ...(s.sources ?? []).flatMap((x) => (x.spec.preset ? [x.spec.preset] : []))]);

export async function createPhaserRecipe(ctx: ToolContext, raw: CreateArgs): Promise<OperationResult> {
  const op = "edit_phaser_recipe";
  const v = new Validator();
  if (raw.action !== "create") v.fail("createPhaserRecipe handles action create (set, add_line and remove_line: editPhaserRecipe)");
  if (raw.recook !== undefined && raw.recook !== false) v.fail("recook is for set, add_line and remove_line: a new preset has no calling cue yet");
  const target = v.check(() => presetId("preset", raw.preset));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const specs: LineSpec[] = [];
  const topLevel = LINE_FIELDS.filter((f) => raw[f] !== undefined);
  if (raw.lines !== undefined) {
    if (topLevel.length) v.fail(`give lines, or the fields of one line (${LINE_FIELDS.join(", ")}), not both (got ${topLevel.join(", ")} next to lines)`);
    if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > MAX_LINES) v.fail(`lines must be a list of 1 to ${MAX_LINES} lines`);
    else
      raw.lines.forEach((l, i) => {
        const s = l && typeof l === "object" && !Array.isArray(l) ? parseLine(v, l as Record<string, unknown>, `lines[${i}]`) : (v.fail(`lines[${i}] must be an object`), undefined);
        if (s) specs.push(s);
      });
  } else {
    const s = parseLine(v, raw as Record<string, unknown>, "");
    if (s) specs.push(s);
  }
  if (target) {
    for (const l of specs) if (stepPresets(l).some((s) => s.pool === target.pool && s.number === target.number)) v.fail("a step preset cannot be the target preset itself");
  }
  // The same 2 steps on the same selection (Group and MAtricks; lines 2+ keep line 1's MAtricks) are a duplicate; on another group or MAtricks they are two lines of one effect (e.g. split by family).
  const selectionOf = (i: number): Selection => ({ group: specs[i].selection, matricks: specs[i].matricks ?? specs[0].matricks ?? null });
  const seen = new Map<string, number>();
  specs.forEach((l, i) => {
    const p = pair(l);
    if (p === null) return;
    const key = `${p}|${selectionOf(i).group}|${selectionOf(i).matricks}`;
    const first = seen.get(key);
    if (first !== undefined) v.fail(`lines ${first + 1} and ${i + 1} have the same 2 step presets (${p}) on the same selection (${selectionText(selectionOf(i))}): two identical lines would cook the same values twice; give one of them another group or MAtricks, or drop it`);
    else seen.set(key, i);
  });
  if (specs[0]?.matricks !== undefined && specs.some((l) => l.matricks === undefined)) v.fail("lines[0] has a MAtricks and another line has none: the other lines are copies of line 1 and keep its MAtricks; give every line one, or put a line without MAtricks first");
  // Preferred, not required: one family per line (a cue reads more clearly). All-pool step presets may mix families.
  const advice = specs.flatMap((l, i) => (stepPresets(l).some((s) => s.pool >= 21 && s.pool <= 25) ? [`line ${i + 1} takes its steps from an All pool (${stepPresets(l).find((s) => s.pool >= 21 && s.pool <= 25)!.pool}): its presets may mix families; one family per line (Dimmer, Colour, Position... each its own line) is preferred`] : []));
  // Transform: a Mirror without wings mirrors nothing; a copy of a Mirror line 1 is mirrored too unless it says otherwise.
  const transformNotes = specs.flatMap((l, i) => [
    ...mirrorWithoutWings(specs.length > 1 ? `line ${i + 1}` : "the line", expectedTransform(specs, i)),
    ...(i > 0 && l.transform === undefined && l.matricks === undefined && specs[0].transform === "mirror" ? [`line ${i + 1} is a copy of line 1 and keeps its Transform Mirror (and its columns): give it transform: "none" to leave it unmirrored`] : []),
  ]);
  const preview = raw.preview === true;
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: the build uses the programmer (it is checked empty first, and cleared with ClearAll at the end) and the Edit Recipe mode; nobody else may use them meanwhile");
  const tgt: Record<string, unknown> = { action: raw.action, preset: raw.preset };
  if (!v.ok || !target || specs.length === 0) return validationFailure(op, tgt, v.errors);
  const ref = `Preset ${target.pool}.${target.number}`;
  const lineAt = (k: number) => `${ref}.${k}`;
  const sourceAt = (k: number, step: number, source = 1) => `${ref}.${k}.1.${step}.${source}`;
  tgt.ref = ref;
  const bridge = ctx.bridge;
  const tm = ctx.requestTimeoutMs;
  const first = specs[0];
  // Line 1 is given one preset per step: built with At Preset in the mode. Otherwise (sources) without, set after the store.
  const inMode = first.steps.every((s) => s.pool !== undefined && s.attribute === undefined);

  const build: string[] = [`Group ${first.selection}`, `At Shape ${first.shape}`, ...(inMode ? ["Step 1", `At Preset ${first.steps[0].pool}.${first.steps[0].number}`, "Step 2", `At Preset ${first.steps[1].pool}.${first.steps[1].number}`] : []), ...(first.matricks !== undefined ? [`MAtricks ${first.matricks}`] : [])];
  // Filled by the checks: the layout of each line (its shape's) and what each source is given.
  const layouts: Layout[] = [];
  /** Each line's layout with the attributes it gives its sources (Assign Attribute). */
  const effLayouts: Layout[] = [];
  const resolved: Resolved[][][] = [];
  /** A source's attribute as the line gives it, when it differs from what the line starts with (line 1: the shape's; a copy: line 1's). */
  const attributeActions = (k: number): Action[] =>
    (effLayouts[k - 1]?.[0] ?? []).flatMap((x, s) => {
      const from = k === 1 ? layouts[0][0][s].attribute : effLayouts[0][0][s].attribute;
      const same = from === null || x.attribute === null ? from === x.attribute : eqi(from, x.attribute);
      return same ? [] : [attributeAction(sourceAt(k, 1, s + 1), x.attribute)];
    });
  const line1Assigns = (): Action[] =>
    inMode
      ? []
      : [
          ...attributeActions(1),
          ...resolved[0].flatMap((st, n) => st.flatMap((r, s): Action[] => (r.preset ? [{ kind: "cmd", command: `Assign Preset ${pkey(r.preset)} At ${sourceAt(1, n + 1, s + 1)}` }] : isHard(r) ? hardActions(sourceAt(1, n + 1, s + 1), r, false) : []))),
        ];
  /**
   * Actions that make line k (k >= 2) out of a copy of line 1: its sources' attributes, then each source's preset or
   * hard values; a source given nothing loses line 1's preset (back to the shape's value). A copy keeps line 1's hard
   * values, and no command takes them back to the shape's: such a source must be given something (checked first).
   */
  const copyActions = (k: number, l: LineSpec): Action[] => [
    { kind: "cmd", command: `Copy ${lineAt(1)} At ${lineAt(k)} /NoConfirmation` },
    ...(l.selection !== first.selection ? [{ kind: "cmd", command: `Assign Group ${l.selection} At ${lineAt(k)}` } as Action] : []),
    ...(l.shape !== first.shape ? [{ kind: "cmd", command: `Assign Shape ${l.shape} At ${lineAt(k)}` } as Action] : []),
    ...(l.matricks !== undefined && l.matricks !== first.matricks ? [{ kind: "cmd", command: `Assign MAtricks ${l.matricks} At ${lineAt(k)}` } as Action] : []),
    ...attributeActions(k),
    ...resolved[k - 1].flatMap((st, n) =>
      st.flatMap((r, s): Action[] => {
        const src = sourceAt(k, n + 1, s + 1);
        const had = !!resolved[0][n]?.[s]?.preset;
        if (r.preset) return [{ kind: "cmd", command: `Assign Preset ${pkey(r.preset)} At ${src}` }];
        if (isHard(r)) return hardActions(src, r, had);
        return had ? [{ kind: "set", ref: src, property: "PRESET", value: "", expect: "empty" }] : [];
      }),
    ),
  ];
  // Filled by the checks: the masters' names (the line reads its link by name) and the shapes' adaptive flags.
  let masterNames = new Map<number, string>();
  const shapeFlags = new Map<number, Flags>();
  /** The line's own settings, in order: the adaptive flags before MEASURE (under Adaptive Measure the console ignores MEASURE, live 2026-11-14 on Chase) and before the widths (set later); the master last. */
  const settingsOf = (k: number, l: LineSpec): Action[] => lineSettings(lineAt(k), l, masterNames, predictFlags(specs, k - 1, shapeFlags));
  const curveCommands = (k: number, l: LineSpec) => l.steps.flatMap((s, i) => (s.curve ? (layouts[k - 1]?.[i] ?? [null]).map((_, src) => `Set ${sourceAt(k, i + 1, src + 1)} Property "Curve" "${curveConsole(s.curve!)}"`) : []));
  const sourceActions = (k: number) => sourceSettings((step, source) => sourceAt(k, step, source), resolved[k - 1] ?? []);
  let plan: string[] = [];
  const makePlan = () => [
    `Store ${ref} /NoConfirmation   (empty programmer, free slot: creates the preset and clears the pending Edit Recipe target)`,
    `EditRecipe ${ref}   (queued; the mode is read back on, Part Zero empty)`,
    ...build,
    `Store ${ref} /Merge /NoConfirmation`,
    "EditRecipe   (queued; the mode is read back off)",
    "ClearAll",
    ...(name !== undefined ? [`set ${ref} Name=${name}`] : []),
    ...line1Assigns().map(actionText),
    ...specs.flatMap((l, i) => [...(i > 0 ? copyActions(i + 1, l).map(actionText) : []), ...settingsOf(i + 1, l).map(actionText)]),
    // After every copy: a copy keeps its source's custom curves (live 2026-11-14), so line 1's must not be set yet.
    ...specs.flatMap((l, i) => curveCommands(i + 1, l)),
    ...specs.flatMap((_, i) => sourceActions(i + 1).map(actionText)),
    `Cook ${ref} /MergeLowPriority`,
  ];

  const body = async (): Promise<OperationResult> => {
    const steps_: StepResult[] = [];
    const fail = (summary: string, extra: Record<string, unknown> = {}) => buildResult({ operation: op, target: tgt, steps: steps_, summary, extra: { plan, ...extra } });
    const read = async (name_: string, fn: () => Promise<string | null>, opName?: string): Promise<boolean> => {
      try {
        const problem = await fn();
        steps_.push(asRead({ name: name_, status: problem ? "failed" : "succeeded", ...(opName ? { op: opName } : {}), ...(problem ? { error: problem } : {}) }));
        return !problem;
      } catch (err) {
        steps_.push(asRead(stepFromError(name_, err, opName ? { op: opName } : {})));
        return false;
      }
    };

    // ---- Checks: nothing is sent unless all pass.
    const presetRows = new Map<string, Row[]>();
    let sourcesChecked = false;
    const adaptiveNotes: string[] = [];
    const masterWarnings: string[] = [];
    const ok =
      (await read("read_target", async () => ((await readPreset(bridge, ref, tm)) ? `${ref} exists: the phaser is built in a free preset slot (EditRecipe would reload an existing preset's lines, and an empty Store into it would wipe them)` : null), "preset.read")) &&
      (await read("check_references", async () => {
        const refs = new Set<string>();
        for (const l of specs) {
          refs.add(`Group ${l.selection}`);
          refs.add(`Shape ${l.shape}`);
          if (l.matricks !== undefined) refs.add(`MAtricks ${l.matricks}`);
        }
        const missing: string[] = [];
        for (const r of refs) if (!(await exists(bridge, r, tm))) missing.push(r);
        for (const p of new Set(specs.flatMap((l) => stepPresets(l).map(pkey)))) {
          const d = await readPreset(bridge, `Preset ${p}`, tm);
          if (!d) missing.push(`Preset ${p}`);
          else presetRows.set(p, d.rows ?? []);
        }
        missing.push(...(await missingAttributes(bridge, specs.flatMap((l) => givenAttributes(l.steps)), tm)));
        return missing.length ? `not in the show: ${missing.join(", ")}` : null;
      })) &&
      (await read("check_value_sources", async () => {
        const shapes = new Map<number, Layout>();
        for (const s of new Set(specs.map((l) => l.shape))) {
          const l = await readLayout(bridge, `Shape ${s}.1`, tm);
          if (!l) return `Shape ${s} has no phaser recipe to read its steps from`;
          if (l.length !== 2) return `Shape ${s} has ${l.length} step(s): this release builds 2-step lines`;
          shapes.set(s, l);
        }
        const problems: string[] = [];
        specs.forEach((l, i) => {
          const layout = shapes.get(l.shape)!;
          const label = specs.length > 1 ? `line ${i + 1}` : "the line";
          if (i > 0 && !sameLayout(layout, shapes.get(first.shape)!))
            problems.push(`line ${i + 1}: Shape ${l.shape}'s value sources (${layoutText(layout)}) are not line 1's (Shape ${first.shape}: ${layoutText(shapes.get(first.shape)!)}); lines 2+ are copies of line 1 and keep its value sources: put this line first, or in a preset of its own`);
          const r = resolveSteps(l.steps, layout, label, specs.length > 1 ? `lines[${i}].steps` : "steps");
          problems.push(...r.errors, ...attributeProblems(label, layout, r.res));
          const eff = effectiveLayout(layout, r.res);
          layouts.push(layout);
          effLayouts.push(eff);
          resolved.push(r.res);
          if (!r.errors.length) problems.push(...sourceProblems(label, presetsOf(r.res), eff, target, presetRows, hardOf(r.res)));
          // A copy keeps line 1's hard values and nothing takes them back to the shape's: the line must give that source something.
          if (i > 0)
            r.res.forEach((st, n) =>
              st.forEach((x, s) => {
                if (isHard(resolved[0][n]?.[s]) && x.preset === undefined && !isHard(x))
                  problems.push(`${label} step ${n + 1} ${sourceName(layout, s)}: line 1 gives it hard values, which the copy keeps (no command takes them back to the shape's value): give it a preset or hard values, or put a line with presets first`);
              }),
            );
        });
        if (problems.length) return [...new Set(problems)].join("; ");
        const sigs = resolved.flatMap((r, i) => sigsOf(i + 1, presetsOf(r), effLayouts[i], hardOf(r), selectionOf(i)));
        for (const [a, g] of sigs.entries()) {
          const other = sigs.slice(a + 1).find((h) => h.line !== g.line && clash(g, h));
          if (other) return `lines ${g.line} and ${other.line} have the same 2 step ${g.pair.split("/").some(isHardKey) ? "values" : "presets"} (${sigText(g)}${g.attribute ? ` on ${g.attribute}` : ""}) on the same selection (${selectionText(g.selection)}): two identical lines would cook the same values twice`;
        }
        sourcesChecked = true;
        return null;
      }, "children")) &&
      (await read("check_adaptive_and_masters", async () => {
        for (const sh of new Set(specs.map((l) => l.shape))) shapeFlags.set(sh, await readShapeFlags(bridge, sh, tm));
        const problems: string[] = [];
        specs.forEach((l, i) => {
          const before_ = predictFlags(specs, i, shapeFlags);
          const label = specs.length > 1 ? `line ${i + 1}` : "the line";
          if (l.steps.some(givesWidth) && before_.adaptiveWidth === true && l.adaptiveWidth !== false)
            problems.push(`${label}: Shape ${l.shape} has Adaptive Width (the console sets each width to 100 / phase positions and ignores WIDTHX): give adaptive_width: false to set a width (it changes the look: under Adaptive Width a chase lights one position at a time)`);
          if (l.measure !== undefined && before_.adaptiveMeasure === true)
            adaptiveNotes.push(`${label}: Shape ${l.shape} has Adaptive Measure (the console sets the measure to the number of phase positions: fixtures, or MAtricks positions); measure ${l.measure} switches it off on the line (PLAYBACKADAPTIVEMEASURE No before MEASURE), so one cycle lasts ${l.measure} beat(s) instead of one beat per position`);
        });
        const wanted = specs.flatMap((l) => (typeof l.speedMaster === "number" ? [l.speedMaster] : []));
        if (wanted.length) {
          masterNames = await readMasterNames(bridge, tm);
          const m = masterProblems(wanted, masterNames);
          problems.push(...m.problems);
          masterWarnings.push(...m.warnings);
        }
        return problems.length ? problems.join("; ") : null;
      }, "objects")) &&
      (await read("read_edit_state", async () => {
        const s = await readEditState(bridge, tm);
        if (s.modalError) return `whether a dialog is open cannot be read (${s.modalError})`;
        if (s.modal) return `a dialog is open (${s.modal.title ?? "untitled"}): answer it first`;
        if (s.editing) return "the Edit Recipe mode is on: switch it off first";
        if (s.partZeroLines.length) return `the programmer's Part Zero holds ${s.partZeroLines.length} recipe line(s)`;
        return null;
      }, "recipe.editState")) &&
      (await read("read_programmer", async () => {
        const n = await programmerValues(bridge, tm);
        if (n === null) return "the programmer could not be read completely, so it is not known to be empty";
        return n > 0 ? `the programmer holds ${n} value(s): the build would store them into the phaser, and its final ClearAll would discard them. Clear or store them first` : null;
      }, "programmer")) &&
      (await read("read_store_preferences", async () => {
        const c = (await bridge.request("preset.context", {}, tm)) as { preferencesReadable?: boolean; preferences?: Record<string, unknown> };
        if (!c.preferencesReadable) return "the store preferences cannot be read";
        const m = String(c.preferences?.RecipeStoreMode ?? "");
        return m === "Normal" ? null : `the store preference RecipeStoreMode is ${JSON.stringify(m)}, not Normal`;
      }, "preset.context"));
    if (sourcesChecked && shapeFlags.size) plan = makePlan();
    if (!ok) return fail(`${op} was not performed; nothing was sent: ${steps_.find((s) => s.status !== "succeeded")?.error ?? "a check failed"}`);
    // A source left to the shape's value outputs that value (an absolute Dimmer 100 / 0, a relative Pan 0): named, so it is a choice.
    const shapeValued = resolved.flatMap((r, i) =>
      sigsOf(i + 1, presetsOf(r), effLayouts[i], hardOf(r)).flatMap((g) => (g.pair.split("/").includes("-") ? [`line ${i + 1} ${g.attribute ?? `source ${g.source + 1}`}: ${g.pair.split("/").map((p, n) => (p === "-" ? `step ${n + 1}` : null)).filter(Boolean).join(" and ")} keep(s) the shape's value`] : [])),
    );
    const notes = shapeValued.length ? [`value sources without a preset output the shape's own value: ${shapeValued.join("; ")}`] : [];
    const previewWarnings = [...advice, ...adaptiveNotes, ...masterWarnings, ...transformNotes];
    if (preview) return buildResult({ operation: op, target: tgt, steps: steps_, summary: "Preview only; nothing was sent.", ...(previewWarnings.length ? { warnings: previewWarnings } : {}), extra: { plan, preview: true, ...(notes.length ? { notes } : {}) } });

    // ---- Line 1 in Edit Recipe mode.
    let created = false;
    let stored = false;
    const cmd = async (name_: string, command: string) => {
      const s = await commandStep(bridge, name_, command, tm);
      steps_.push(s);
      return s.status === "succeeded";
    };
    const act = async (name_: string, a: Action) => {
      const s = await runAction(bridge, name_, a, tm);
      steps_.push(s);
      return s.status === "succeeded";
    };
    const waitMode = async (want: boolean): Promise<{ state: EditState | null; error?: string }> => {
      const until = Date.now() + MODE_WAIT_MS;
      let last: EditState | null = null;
      for (;;) {
        try {
          last = await readEditState(bridge, tm);
        } catch (err) {
          return { state: last, error: `recipe.editState failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (last.modal || last.modalError || last.editing === want) return { state: last };
        if (Date.now() > until) return { state: last, error: `the Edit Recipe mode still reads ${last.editing ? "on" : "off"} after ${MODE_WAIT_MS} ms` };
        await sleep(POLL_MS);
      }
    };
    /** Answer "Update last object?" with Cancel (never OK); any other dialog is left alone. */
    const cancelUpdateDialog = async (s: EditState): Promise<string> => {
      const m = s.modal;
      if (!m) return "";
      if (m.title !== UPDATE_DIALOG || !m.buttons?.some((b) => b.text === "Cancel")) return `a dialog opened (${m.title ?? "untitled"}: ${m.text ?? ""}); it was left open, answer it on the console`;
      try {
        await bridge.request("dialog.press", { button: "Cancel", exclusive: true, ...(m.class ? { expectClass: m.class } : {}), expectTitle: m.title ?? "", expectText: m.text ?? "" }, tm);
        steps_.push({ name: "cancel_dialog", status: "succeeded", op: "dialog.press", detail: { title: m.title, text: m.text } });
        return `"${UPDATE_DIALOG}" opened (${m.text ?? ""}) and was cancelled (never OK: OK would overwrite that object with the programmer)`;
      } catch (err) {
        steps_.push(stepFromError("cancel_dialog", err, { op: "dialog.press" }));
        return `"${UPDATE_DIALOG}" opened (${m.text ?? ""}) and pressing Cancel failed: answer Cancel on the console`;
      }
    };
    const checkLine = async (name_: string, when: string): Promise<boolean> =>
      read(name_, async () => {
        const s = await readEditState(bridge, tm);
        if (s.modal) return `a dialog is open (${s.modal.title ?? "untitled"})`;
        if (!s.editing) return `the Edit Recipe mode is off ${when}`;
        const ph = s.partZeroLines.filter((l) => l.class === "PhaserRecipe");
        if (ph.length !== 1 || s.partZeroLines.length !== 1) return `Part Zero holds ${s.partZeroLines.length} line(s) (${ph.length} phaser) ${when}, 1 phaser line expected`;
        return null;
      }, "recipe.editState");

    /** After a failure: mode off, programmer cleared, and the preset removed if this call created it and never stored into it. */
    const abort = async (why: string): Promise<OperationResult> => {
      const notes_: string[] = [why];
      // The build did not complete, whatever the clean-up does: the outcome must not read as a success.
      steps_.push({ name: "build_aborted", status: "failed", error: why || "the build stopped" });
      try {
        let s = await readEditState(bridge, tm);
        if (s.modal) notes_.push(await cancelUpdateDialog(s));
        s = await readEditState(bridge, tm);
        if (s.editing && !s.modal) {
          steps_.push({ name: "abort_edit_end", status: "succeeded", op: "recipe.editEnd", detail: await bridge.request("recipe.editEnd", { exclusive: true }, tm) });
          const w = await waitMode(false);
          if (w.error || w.state?.editing) notes_.push(`the Edit Recipe mode could not be switched off (${w.error ?? "still on"}): switch it off on the console`);
        }
        s = await readEditState(bridge, tm);
        if (!s.editing && !s.modal) {
          await cmd("abort_clear", "ClearAll");
          if (created && !stored) await cmd("abort_delete_preset", `Delete ${ref} /NoConfirmation`);
        } else notes_.push("the programmer was not cleared (the mode or a dialog is still open)");
      } catch (err) {
        steps_.push(stepFromError("abort", err));
        notes_.push("the clean-up did not finish: check the Edit Recipe mode, Part Zero and the programmer on the console");
      }
      return fail(notes_.filter(Boolean).join("; "));
    };

    if (!(await cmd("reset_store", `Store ${ref} /NoConfirmation`))) return fail(`the empty store of ${ref} failed; nothing else was sent`);
    created = true;
    try {
      steps_.push({ name: "edit_begin", status: "succeeded", op: "recipe.editBegin", detail: await bridge.request("recipe.editBegin", { target: ref, exclusive: true }, tm) });
    } catch (err) {
      steps_.push(stepFromError("edit_begin", err, { op: "recipe.editBegin" }));
      return abort("EditRecipe was not queued");
    }
    const begun = await waitMode(true);
    if (begun.state?.modal) return abort(await cancelUpdateDialog(begun.state));
    if (begun.error || !begun.state?.editing) return abort(begun.error ?? "the Edit Recipe mode did not switch on");
    if (begun.state.partZeroLines.length) return abort(`EditRecipe loaded ${begun.state.partZeroLines.length} line(s) into Part Zero`);
    steps_.push(asRead({ name: "edit_mode_on", status: "succeeded", op: "recipe.editState" }));

    for (const [i, c] of build.entries()) {
      if (!(await cmd(`build_${i + 1}`, c))) return abort(`"${c}" failed`);
      if (c.startsWith("At Shape") && !(await checkLine("check_line", "after At Shape"))) return abort("the phaser line was not created as expected");
    }
    if (!(await checkLine("check_before_store", "before the store"))) return abort("the programmer is not as expected before the store");
    if (!(await cmd("store", `Store ${ref} /Merge /NoConfirmation`))) return abort("the store failed");
    stored = true;
    if (!(await read("check_after_store", async () => {
      const s = await readEditState(bridge, tm);
      return s.partZeroLines.length ? `Part Zero still holds ${s.partZeroLines.length} line(s) after the store` : null;
    }, "recipe.editState"))) return abort("the store did not take the line");
    try {
      steps_.push({ name: "edit_end", status: "succeeded", op: "recipe.editEnd", detail: await bridge.request("recipe.editEnd", { exclusive: true }, tm) });
    } catch (err) {
      steps_.push(stepFromError("edit_end", err, { op: "recipe.editEnd" }));
      return abort("EditRecipe (off) was not queued");
    }
    const ended = await waitMode(false);
    if (ended.state?.modal) return abort(await cancelUpdateDialog(ended.state));
    if (ended.error || ended.state?.editing) return abort(ended.error ?? "the Edit Recipe mode did not switch off");
    if (!(await cmd("clear", "ClearAll"))) return abort("ClearAll failed");
    await read("check_programmer_clear", async () => {
      const n = await programmerValues(bridge, tm);
      const s = await readEditState(bridge, tm);
      if (n !== 0) return `the programmer holds ${n ?? "an unknown number of"} value(s) after ClearAll`;
      return s.partZeroLines.length ? `Part Zero holds ${s.partZeroLines.length} line(s) after ClearAll` : null;
    }, "programmer");

    // ---- From here the preset holds line 1: a failure is reported, the preset is kept.
    const notDone: string[] = [];
    if (name !== undefined) {
      try {
        const r = (await bridge.request("set", { ref, property: "Name", value: name }, tm)) as { value?: unknown };
        const good = String(r?.value ?? "") === name;
        steps_.push({ name: "label", status: good ? "succeeded" : "failed", op: "set", ...(good ? {} : { error: `Name reads ${JSON.stringify(r?.value)}` }) });
        if (!good) notDone.push("name");
      } catch (err) {
        steps_.push(stepFromError("label", err, { op: "set" }));
        notDone.push("name");
      }
    }
    // Line 1 given per value source: each source's preset now (the mode had none: At Preset fills every source).
    for (const [j, a] of line1Assigns().entries()) if (!(await act(`line1_source_${j + 1}`, a))) notDone.push(`line 1 ${actionText(a)}`);
    let linesMade = 1;
    for (const [i, l] of specs.entries()) {
      const k = i + 1;
      if (k > 1) {
        let made = true;
        for (const [j, a] of copyActions(k, l).entries()) {
          if (!(await act(`line${k}_${j === 0 ? "copy" : `assign_${j}`}`, a))) {
            made = false;
            break;
          }
          if (j === 0) {
            const n = await readLines(bridge, { kind: "preset", pool: target.pool, number: target.number }, tm).catch(() => null);
            const good = n?.length === k && n[k - 1]?.class === "PhaserRecipe";
            steps_.push(asRead({ name: `line${k}_copied`, status: good ? "succeeded" : "failed", op: "children", ...(good ? {} : { error: `${ref} has ${n?.length ?? "an unknown number of"} line(s) after the copy, ${k} expected` }) }));
            if (!good) {
              made = false;
              break;
            }
          }
        }
        if (!made) {
          notDone.push(`line ${k} and the lines after it`);
          break;
        }
        linesMade = k;
      }
      for (const a of settingsOf(k, l)) if (a.kind === "set" && !(await act(`line${k}_set_${a.property.toLowerCase()}`, a))) notDone.push(`line ${k} ${a.property}`);
    }
    // Curves after every copy: a copied line keeps line 1's custom curves. Then trans / width (over a curve's TRANS).
    for (const [i, l] of specs.slice(0, linesMade).entries())
      for (const [j, c] of curveCommands(i + 1, l).entries()) if (!(await cmd(`line${i + 1}_curve_${j + 1}`, c))) notDone.push(`line ${i + 1} curve`);
    for (let k = 1; k <= linesMade; k++) for (const [j, a] of sourceActions(k).entries()) if (!(await act(`line${k}_source_setting_${j + 1}`, a))) notDone.push(`line ${k} ${a.kind === "set" ? a.property : "setting"}`);
    await cmd("cook", `Cook ${ref} /MergeLowPriority`);

    // ---- Read back.
    let verification: Verification = notRequested();
    let lines: unknown = null;
    let coverage: unknown = null;
    const createdWarnings: string[] = [];
    const folder = rangeFolder(bridge, tm);
    try {
      const ls = (await readLines(bridge, { kind: "preset", pool: target.pool, number: target.number }, tm)) ?? [];
      const data = await readPreset(bridge, ref, tm);
      const s = await readEditState(bridge, tm);
      const details = (await readLineDetails(bridge, ref, tm)) ?? [];
      lines = ls;
      const problems: string[] = [];
      if (ls.length !== specs.length) problems.push(`${ref} has ${ls.length} recipe line(s), ${specs.length} expected`);
      const rows = await folder.fold(data?.rows ?? []);
      const uncooked = rows.filter((r) => r.cooked !== true);
      if (!rows.length) problems.push(`${ref} holds no values (nothing cooked)`);
      if (uncooked.length) problems.push(`${ref} holds ${uncooked.length} uncooked value(s): stored directly, not from the recipe`);
      if (data?.truncated) problems.push(`${ref} was not read completely`);
      // Each cooked value belongs to the value source whose step presets it integrates (and whose attribute it is), or
      // on a Mirror line (as read) to its mirrored values on the line's group.
      const groups = new Map<number, GroupInfo>();
      const sigs: Sig[][] = [];
      for (const [i, r] of resolved.entries()) sigs.push(await withMirror(bridge, tm, sigsOf(i + 1, presetsOf(r), effLayouts[i], hardOf(r), selectionOf(i)), details[i] && { ...details[i], group: specs[i].selection }, groups));
      // Lines with the same steps on other groups: each one's values are those on its group's fixtures.
      const ambiguous = await scopeTwins(bridge, tm, sigs.flat(), groups);
      if (ambiguous.length) createdWarnings.push(ambiguousNote(ambiguous));
      const stray = rows.filter((r) => !sigs.some((gs) => gs.some((g) => rowMatches(r, g))));
      if (stray.length) problems.push(`${stray.length} value(s) do not have 2 steps from one line's step presets (first: fixture ${stray[0].fixture} ${stray[0].attribute}, steps ${rowPairOf(stray[0])})`);
      const multi = layouts.some((l) => l.some((st) => st.length > 1));
      for (const [i, l] of specs.entries()) {
        const k = i + 1;
        const got = ls[i];
        if (!got) continue;
        if (got.class !== "PhaserRecipe") problems.push(`line ${k} is a ${got.class}, not a PhaserRecipe`);
        if (got.selection?.group !== l.selection) problems.push(`line ${k} selection reads ${got.selection ? `Group ${got.selection.group}` : "none"}`);
        if (l.matricks !== undefined && got.matricks?.no !== l.matricks) problems.push(`line ${k} MAtricks reads ${got.matricks?.no ?? "none"}`);
        if (got.status.failedCookedPart && got.status.failedCookedPart !== "None") problems.push(`line ${k} failed to cook (${got.status.failedCookedPart})`);
        // The adaptive flags and the speed master the line must read (what it set, or line 1's for a copy).
        const exp = expectedLine(specs, i);
        const det = details[i];
        problems.push(...flagMasterDiff(`line ${k}`, det, { ...exp.flags, ...(exp.master !== undefined ? { speedMaster: exp.master === null ? "" : (masterNames.get(exp.master) ?? "") } : {}) }));
        if (det?.speedMaster) createdWarnings.push(...masterSpeedWarning(`line ${k}`, det.speedMaster, det.speedHz));
        problems.push(...hardDiff(`line ${k}`, det, effLayouts[i], resolved[i]));
        problems.push(...transformDiff(`line ${k}`, det, expectedTransform(specs, i)));
        const others = sigs.filter((_, j) => j !== i).flat();
        const sourceOf = (r: Row) => ownerSig(r, sigs[i], others);
        // A value of a source without a preset that another line could have made too is not this line's to check.
        const claimed = rows.filter((r) => sourceOf(r) !== undefined && (hasPreset(sourceOf(r)!) || !sigs.some((gs, j) => j !== i && gs.some((g) => rowMatches(r, g)))));
        // Evidence that the line cooked: its own step presets or hard values (a mirrored value is not).
        for (const g of sigs[i].filter(hasPreset))
          if (!claimed.some((r) => rowMatches(r, g, true))) problems.push(`no cooked value comes from line ${k}${multi ? ` ${g.attribute ?? `source ${g.source + 1}`}` : ""} (${sigText(g)})`);
        // A value that a twin on the same fixtures could have made too is not this line's to compare.
        const mine = claimed.filter((r) => !others.some((h) => hasPreset(h) && straightMatch(r, h)));
        if (!mine.length) continue;
        // The cooked speed is in Hz (60 BPM = 1 Hz), the measure x100. The phase is spread per fixture by the MAtricks: only its set reply is compared.
        if (l.speed !== undefined) {
          const off = mine.filter((r) => typeof r.speed !== "number" || Math.abs(r.speed - l.speed! / 60) > 0.001);
          if (off.length) problems.push(`line ${k}: ${off.length} value(s) do not run at ${l.speed} BPM (${(l.speed / 60).toFixed(3)} Hz; first: fixture ${off[0].fixture} ${off[0].attribute} reads ${off[0].speed ?? "none"})`);
        }
        if (l.measure !== undefined) {
          const off = mine.filter((r) => typeof r.measure !== "number" || Math.abs(r.measure / 100 - l.measure!) > 0.01);
          if (off.length) problems.push(`line ${k}: ${off.length} value(s) do not have Measure ${l.measure} (first: fixture ${off[0].fixture} ${off[0].attribute} reads ${typeof off[0].measure === "number" ? off[0].measure / 100 : "none"})`);
        }
        if (exp.master !== undefined) problems.push(...cookedMasterDiff(`line ${k}`, mine, exp.master));
        const res = resolved[i];
        l.steps.forEach((st, n) => {
          if (!st.curve || st.curve === "reset") return;
          const c = CURVES[st.curve];
          const off = mine.filter((r) => {
            const own = r.steps?.[n];
            const next = r.steps?.[(n + 1) % 2];
            const given = res[n]?.[sourceOf(r)!.source]?.trans;
            // A named curve writes the step's TRANS too: 0 for Snap, 100 otherwise (Flyout's Dimmer 10 % became 100 % with Linear, live 2026-11-14).
            const trans = given ?? ("trans" in c ? c.trans : 100);
            return !near(own?.decel, c.decel, 0.01) || !near(next?.accel, c.nextAccel, 0.01) || (trans !== undefined && !near(own?.trans ?? 100, trans, 0.01));
          });
          if (off.length) problems.push(`line ${k} step ${n + 1}: ${off.length} value(s) do not have the ${c.console} curve (first: fixture ${off[0].fixture} ${off[0].attribute})`);
        });
        // Trans and width asked per source; with Link Steps the other step's width takes the rest of the shape's sum.
        const shapeWidths = k === 1 || l.shape === first.shape ? layouts[i] : null;
        for (let n = 0; n < 2; n++)
          for (const kind of ["trans", "width"] as const) {
            const off = mine.filter((r) => {
              const src = sourceOf(r)!.source;
              let want = res[n]?.[src]?.[kind];
              const other = res[(n + 1) % 2]?.[src]?.width;
              if (kind === "width" && want === undefined && other !== undefined && shapeWidths) {
                const a = shapeWidths[0]?.[src]?.width;
                const b = shapeWidths[1]?.[src]?.width;
                if (a !== undefined && b !== undefined) want = a + b - other;
              }
              return want !== undefined && !near(r.steps?.[n]?.[kind] ?? 100, want, 0.01);
            });
            if (off.length) problems.push(`line ${k} step ${n + 1}: ${off.length} value(s) do not have the ${kind} asked (first: fixture ${off[0].fixture} ${off[0].attribute} reads ${off[0].steps?.[n]?.[kind] ?? 100})`);
          }
      }
      if (s.editing) problems.push("the Edit Recipe mode is on");
      if (s.partZeroLines.length) problems.push(`Part Zero holds ${s.partZeroLines.length} line(s)`);
      if (s.modal) problems.push(`a dialog is open (${s.modal.title ?? "untitled"})`);
      coverage = { cooked: rows.length - uncooked.length, uncooked: uncooked.length, fixtures: [...new Set(rows.map((r) => r.fixture))].length, attributes: [...new Set(rows.map((r) => r.attribute))] };
      steps_.push(asRead({ name: "read_back", status: "succeeded", op: "preset.read" }));
      const what = `${ref}: ${specs.length} PhaserRecipe line(s), every value cooked with its value source's step presets${specs.some((l) => l.speed !== undefined) ? ", speed" : ""}${specs.some((l) => l.measure !== undefined) ? ", measure" : ""}${specs.some((l) => l.steps.some((x) => x.curve)) ? ", curves" : ""}${resolved.some((r) => r.some((st) => st.some((x) => x.trans !== undefined || x.width !== undefined))) ? ", trans / width" : ""}, the Edit Recipe mode off, Part Zero and the programmer empty`;
      verification = problems.length ? { status: "mismatched", checked: what, detail: problems.join("; ") } : { status: "matched", checked: what };
    } catch (err) {
      steps_.push(asRead(stepFromError("read_back", err, { op: "preset.read" })));
    }
    const warnings = [...advice, ...adaptiveNotes, ...masterWarnings, ...transformNotes, ...createdWarnings, ...folder.finish(), "Between At Shape and the final ClearAll line 1 ran in the programmer (it was output on stage).", `${ref} stays the pending Edit Recipe target: a manual EditRecipe on another target opens "${UPDATE_DIALOG}" (answer Cancel, never OK).`];
    if (notDone.length) warnings.push(`not done as asked: ${notDone.join(", ")} (the preset and its lines are kept)`);
    return buildResult({ operation: op, target: tgt, steps: steps_, verification, warnings, extra: { plan, lines, linesMade, coverage, ...(notes.length ? { notes } : {}) } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---- Editing an existing phaser preset (actions set, add_line, remove_line). No programmer and no Edit Recipe mode:
// every change is an Assign / Set / Copy / Delete on the preset's lines (live 2026-11-14, THK migration
// docs/phaser-recipes.md §1.9, §1.10):
//   - `Assign Group|Shape|MAtricks n At Preset P.N.L` retargets a line; `Assign Preset X At Preset P.N.L.1.<step>.<s>`
//     changes a value source's preset and keeps its curve; `set PRESET ""` on the source gives it back its own value.
//     A new shape recomputes the steps' accel/decel (and some trans / widths) from the shape; a custom curve (one set
//     with Set ... Property "Curve") survives it, "Reset" restores the shape's.
//   - `Copy Preset P.N.1 At Preset P.N.k` copies line 1 with its custom curves; `Delete Preset P.N.k` removes a line
//     and the later lines move up (3 lines, delete line 2: line 3 becomes line 2); its cooked values go at once.
//   - A cue that calls the preset with a standard line is not guaranteed to follow the change: on the THK bench of
//     2026-11-15 (docs/phaser-recipes.md §3) a cue kept the old width / trans, and once the old speed, until it was
//     re-cooked; Sequence 9000 Cue 11 on 21.9005 followed a speed, a new family and a removed line, and Sequence 9031
//     Cue 1 on 21.9075 (2026-11-15) had a new width and trans in its cooked data at once (even after a bare Set
//     TRANSX). So `recook` re-cooks the calling cue parts and verifies them (phaserrecook.ts); without it the call warns.

interface StepDetail {
  /** Value source 1 (the whole step of a plain shape). */
  preset: PresetRef | null;
  accel?: number;
  decel?: number;
  trans?: number;
  width?: number;
  sources: SourceDetail[];
}
/** One recipe line of a preset as the console reads it (numbers raw: SPEEDX in Hz, phase in degrees, measure in beats). */
export interface LineDetail {
  line: number;
  class: string;
  group: number | null;
  matricks: number | null;
  shape: number | null;
  speedHz?: number;
  phaseFrom?: number;
  phaseTo?: number;
  measure?: number;
  /** PLAYBACKADAPTIVEMEASURE / PLAYBACKADAPTIVEWIDTH (own: set on the line itself, otherwise the shape's). */
  adaptiveMeasure?: boolean;
  adaptiveMeasureOwn?: boolean;
  adaptiveWidth?: boolean;
  adaptiveWidthOwn?: boolean;
  /** SPEEDMASTEROVERRIDE as the console reads it: the master's name, "" for none. */
  speedMaster?: string;
  /** PHASERTRANSFORM ("None" / "Mirror"), INVERTSTYLE ("Pan", "Tilt", "P+T", "All"), XINVW / YINVW, the columns and phase Y (null: None). */
  transform?: string;
  invertStyle?: string;
  xInvW?: boolean;
  yInvW?: boolean;
  columns?: Columns;
  failedCookedPart?: string;
  steps: StepDetail[];
}
/** The Transform fields of a line (as read or as expected); an undefined field is not compared. */
type TransformFields = Pick<LineDetail, "transform" | "invertStyle" | "xInvW" | "yInvW" | "columns">;
/** A column read raw: a number, "None" (null), "90°" or "2" as text. */
const columnOf = (v: unknown): number | null | undefined => (typeof v === "number" ? (Number.isFinite(v) ? v : undefined) : matricksValue("phase", v));
/**
 * The inverts Transform switches (live 2026-11-15, 21.9073): Mirror switches XInvW on with XWings and YInvW with YWings
 * (a column at None leaves its invert off: Mirror without wings mirrors nothing); None switches them off. undefined: not known.
 */
function derivedInverts(transform: string | undefined, cols: Columns | undefined): Pick<LineDetail, "xInvW" | "yInvW"> {
  if (transform === "None") return { xInvW: false, yInvW: false };
  if (transform !== "Mirror") return {};
  const on = (c: number | null | undefined) => (c === undefined ? undefined : c !== null);
  return { xInvW: on(cols?.XWINGS), yInvW: on(cols?.YWINGS) };
}
function transformDiff(label: string, got: LineDetail | undefined, want: TransformFields): string[] {
  if (!got) return [];
  const p: string[] = [];
  const yn = (b: boolean | undefined) => (b === undefined ? "unreadable" : b ? "Yes" : "No");
  if (want.transform !== undefined && got.transform !== want.transform) p.push(`${label} transform reads ${got.transform ?? "unreadable"}, ${want.transform} expected`);
  if (want.invertStyle !== undefined && got.invertStyle !== want.invertStyle) p.push(`${label} invert style reads ${got.invertStyle ?? "unreadable"}, ${want.invertStyle} expected${want.transform === "Mirror" ? " (Mirror sets it to Pan)" : ""}`);
  if (want.xInvW !== undefined && got.xInvW !== want.xInvW) p.push(`${label} XInvW reads ${yn(got.xInvW)}, ${yn(want.xInvW)} expected (Mirror switches it on with XWings)`);
  if (want.yInvW !== undefined && got.yInvW !== want.yInvW) p.push(`${label} YInvW reads ${yn(got.yInvW)}, ${yn(want.yInvW)} expected (Mirror switches it on with YWings)`);
  const txt = (c: number | null | undefined) => (c === null ? "None" : c === undefined ? "unreadable" : String(+c.toFixed(3)));
  for (const prop of COLUMN_PROPS) {
    const w = want.columns?.[prop];
    if (w !== undefined && !columnMatches(w, got.columns?.[prop])) p.push(`${label} ${prop} reads ${txt(got.columns?.[prop])}, ${txt(w)} expected`);
  }
  return p;
}

/** Every recipe line of a preset with its group, MAtricks, shape, speed, phase, measure and value sources; null when the preset is not in the show. */
export async function readLineDetails(bridge: Gma3Bridge, ref: string, t: number): Promise<LineDetail[] | null> {
  let top: ChildList;
  try {
    top = await childList(bridge, ref, ["SPEEDX", "PHASEFROMX", "PHASETOX", "MEASURE", "SHAPE", "MAtricks", "Selection", "FailedCookedPart", "PLAYBACKADAPTIVEMEASURE", "PLAYBACKADAPTIVEWIDTH", "SPEEDMASTEROVERRIDE", "PHASERTRANSFORM", "INVERTSTYLE", "XINVW", "YINVW", ...COLUMN_PROPS], t);
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
  const out: LineDetail[] = [];
  for (const [i, it] of (top.items ?? []).entries()) {
    if (it.class !== "PhaserRecipe" && it.class !== "StandardRecipe") continue;
    const f = it.fields ?? {};
    const line = typeof it.index === "number" ? it.index : i + 1;
    const d: LineDetail = { line, class: it.class, group: numberOf(f.Selection, "Group"), matricks: numberOf(f.MAtricks, "MAtrick"), shape: numberOf(f.SHAPE, "Shape"), steps: [] };
    if (typeof f.FailedCookedPart === "string") d.failedCookedPart = f.FailedCookedPart;
    if (it.class === "PhaserRecipe") {
      d.speedHz = rawNumber(f.SPEEDX);
      d.phaseFrom = rawNumber(f.PHASEFROMX);
      d.phaseTo = rawNumber(f.PHASETOX);
      d.measure = measureOf(f.MEASURE);
      const am = yesNoOf(f.PLAYBACKADAPTIVEMEASURE);
      const aw = yesNoOf(f.PLAYBACKADAPTIVEWIDTH);
      if (am) Object.assign(d, { adaptiveMeasure: am.value, adaptiveMeasureOwn: am.own });
      if (aw) Object.assign(d, { adaptiveWidth: aw.value, adaptiveWidthOwn: aw.own });
      if (typeof f.SPEEDMASTEROVERRIDE === "string") d.speedMaster = f.SPEEDMASTEROVERRIDE.trim();
      else if (f.SPEEDMASTEROVERRIDE === null) d.speedMaster = "";
      if (typeof f.PHASERTRANSFORM === "string" && f.PHASERTRANSFORM.trim()) d.transform = f.PHASERTRANSFORM.trim();
      if (typeof f.INVERTSTYLE === "string" && f.INVERTSTYLE.trim()) d.invertStyle = f.INVERTSTYLE.trim();
      const xi = yesNoOf(f.XINVW);
      const yi = yesNoOf(f.YINVW);
      if (xi) d.xInvW = xi.value;
      if (yi) d.yInvW = yi.value;
      const cols: Columns = {};
      for (const p of COLUMN_PROPS) {
        const c = columnOf(f[p]);
        if (c !== undefined) cols[p] = c;
      }
      if (Object.keys(cols).length) d.columns = cols;
      for (const sources of (await readLayout(bridge, `${ref}.${line}`, t)) ?? []) {
        const s1 = sources[0];
        d.steps.push({ preset: s1?.preset ?? null, accel: s1?.accel, decel: s1?.decel, trans: s1?.trans, width: s1?.width, sources });
      }
    }
    out.push(d);
  }
  return out;
}

/** What a value source should read after the edit; an undefined field is not compared. */
interface SourceExpect {
  attribute: string | null;
  preset?: PresetRef | null;
  /** Own hard values: a number, null (the layer must be absent), undefined (not compared). */
  absolute?: number | null;
  relative?: number | null;
  accel?: number;
  decel?: number;
  trans?: number;
  width?: number;
}
/** What a line should read after the edit; an undefined field is not compared. */
interface LineExpect {
  class: string;
  group: number | null;
  matricks: number | null;
  shape: number | null;
  speedHz?: number;
  phaseFrom?: number;
  phaseTo?: number;
  measure?: number;
  adaptiveMeasure?: boolean;
  adaptiveWidth?: boolean;
  /** The master's name, "" for none. */
  speedMaster?: string;
  transform?: string;
  invertStyle?: string;
  xInvW?: boolean;
  yInvW?: boolean;
  columns?: Columns;
  steps: Array<{ sources: SourceExpect[] }>;
}
const layoutOf = (d: { steps: Array<{ sources: Array<{ attribute: string | null }> }> }): Layout => d.steps.map((st) => st.sources.map((x) => ({ attribute: x.attribute, preset: null })));
const presetsIn = (d: { steps: Array<{ sources: Array<{ preset?: PresetRef | null }> }> }) => d.steps.map((st) => st.sources.map((x) => x.preset));
/** The own hard values of a line's sources (as read, or as expected). */
const hardIn = (d: { steps: Array<{ sources: Array<{ preset?: PresetRef | null; absolute?: number | null; relative?: number | null }> }> }): HardGrid =>
  d.steps.map((st) =>
    st.sources.map((x) => {
      if (x.preset) return undefined;
      const h: Hard = { ...(typeof x.absolute === "number" ? { absolute: x.absolute } : {}), ...(typeof x.relative === "number" ? { relative: x.relative } : {}) };
      return isHard(h) ? h : undefined;
    }),
  );
/**
 * A shape's value sources fit a line's: as many per step, and a source the shape filters on an attribute has that
 * attribute on the line (a line's own attribute on a plain source survives Assign Shape, live 2026-11-15).
 */
const fitsLayout = (shape: Layout, line: Layout) =>
  shape.length === line.length && shape.every((st, n) => st.length === line[n].length && st.every((x, s) => x.attribute === null || (line[n][s].attribute !== null && eqi(x.attribute, line[n][s].attribute!))));

/** The adaptive flags and the speed master (by name, "" for none) a line must read; an undefined field is not compared. */
function flagMasterDiff(label: string, got: LineDetail | undefined, want: { adaptiveMeasure?: boolean; adaptiveWidth?: boolean; speedMaster?: string }): string[] {
  if (!got) return [];
  const p: string[] = [];
  const yn = (b: boolean | undefined) => (b === undefined ? "unreadable" : b ? "Yes" : "No");
  if (want.adaptiveMeasure !== undefined && got.adaptiveMeasure !== want.adaptiveMeasure) p.push(`${label} Adaptive Measure reads ${yn(got.adaptiveMeasure)}, ${yn(want.adaptiveMeasure)} expected`);
  if (want.adaptiveWidth !== undefined && got.adaptiveWidth !== want.adaptiveWidth) p.push(`${label} Adaptive Width reads ${yn(got.adaptiveWidth)}, ${yn(want.adaptiveWidth)} expected`);
  if (want.speedMaster !== undefined && (got.speedMaster ?? "").toLowerCase() !== want.speedMaster.toLowerCase())
    p.push(`${label} speed master reads ${got.speedMaster ? JSON.stringify(got.speedMaster) : got.speedMaster === "" ? "none" : "unreadable"}, ${want.speedMaster ? JSON.stringify(want.speedMaster) : "none"} expected`);
  return p;
}

/** The cooked values of a line follow master n (the cooked speedMaster is 0-based: master 1 reads 0) or none (null). */
function cookedMasterDiff(label: string, rows: Row[], master: number | null): string[] {
  const off = rows.filter((r) => (master === null ? r.speedMaster !== undefined && r.speedMaster !== null : r.speedMaster !== master - 1));
  if (!off.length) return [];
  const read = (r: Row) => (typeof r.speedMaster === "number" ? `master ${r.speedMaster + 1}` : "no master");
  return [`${label}: ${off.length} cooked value(s) do not follow ${master === null ? "no speed master" : `speed master ${master}`} (first: fixture ${off[0].fixture} ${off[0].attribute} reads ${read(off[0])})`];
}

function lineDiff(label: string, got: LineDetail | undefined, want: LineExpect): string[] {
  if (!got) return [`${label} is missing`];
  const p: string[] = [];
  if (got.class !== want.class) p.push(`${label} is a ${got.class}, not a ${want.class}`);
  if (got.group !== want.group) p.push(`${label} selection reads ${got.group === null ? "none" : `Group ${got.group}`}, Group ${want.group} expected`);
  if (got.matricks !== want.matricks) p.push(`${label} MAtricks reads ${got.matricks ?? "none"}, ${want.matricks ?? "none"} expected`);
  if (got.shape !== want.shape) p.push(`${label} shape reads ${got.shape ?? "none"}, Shape ${want.shape} expected`);
  if (!near(got.speedHz, want.speedHz, 0.001)) p.push(`${label} speed reads ${got.speedHz === undefined ? "none" : `${+(got.speedHz * 60).toFixed(3)} BPM`}, ${+(want.speedHz! * 60).toFixed(3)} BPM expected`);
  if (!near(got.phaseFrom, want.phaseFrom, 0.01) || !near(got.phaseTo, want.phaseTo, 0.01)) p.push(`${label} phase reads ${got.phaseFrom} to ${got.phaseTo}, ${want.phaseFrom ?? "(unchanged)"} to ${want.phaseTo ?? "(unchanged)"} expected`);
  if (!near(got.measure, want.measure, 0.01)) p.push(`${label} measure reads ${got.measure ?? "none"}, ${want.measure} expected`);
  p.push(...flagMasterDiff(label, got, want));
  p.push(...transformDiff(label, got, want));
  if (got.failedCookedPart && got.failedCookedPart !== "None") p.push(`${label} failed to cook (${got.failedCookedPart})`);
  if (got.steps.length !== want.steps.length) p.push(`${label} has ${got.steps.length} step(s), ${want.steps.length} expected`);
  want.steps.forEach((w, n) => {
    const g = got.steps[n];
    if (!g) return;
    if (g.sources.length !== w.sources.length) p.push(`${label} step ${n + 1} has ${g.sources.length} value source(s), ${w.sources.length} expected`);
    w.sources.forEach((ws, s) => {
      const gs = g.sources[s];
      if (!gs) return;
      const at = w.sources.length > 1 ? `${label} step ${n + 1} ${ws.attribute ?? `source ${s + 1}`}` : `${label} step ${n + 1}`;
      if (ws.preset !== undefined && pkey(ws.preset) !== pkey(gs.preset)) p.push(`${at} preset reads ${gs.preset ? pkey(gs.preset) : "none"}, ${ws.preset ? pkey(ws.preset) : "none (the shape's value)"} expected`);
      if (ws.attribute === null || gs.attribute === null ? ws.attribute !== gs.attribute : !eqi(ws.attribute, gs.attribute)) p.push(`${at} attribute reads ${gs.attribute ?? "none"}, ${ws.attribute ?? "none"} expected`);
      for (const k of ["absolute", "relative"] as const) {
        const w = ws[k];
        if (w === null ? gs[k] !== undefined : w !== undefined && (gs[k] === undefined || !near(gs[k], w, 0.01))) p.push(`${at} ${k} reads ${gs[k] ?? "none"}, ${w ?? "none"} expected`);
      }
      for (const k of ["accel", "decel", "trans", "width"] as const) if (!near(gs[k], ws[k], 0.01)) p.push(`${at} ${k} reads ${gs[k] ?? "none"}, ${ws[k]} expected`);
    });
  });
  return p;
}
const expectOf = (d: LineDetail): LineExpect => ({ class: d.class, group: d.group, matricks: d.matricks, shape: d.shape, speedHz: d.speedHz, phaseFrom: d.phaseFrom, phaseTo: d.phaseTo, measure: d.measure, adaptiveMeasure: d.adaptiveMeasure, adaptiveWidth: d.adaptiveWidth, speedMaster: d.speedMaster, transform: d.transform, invertStyle: d.invertStyle, xInvW: d.xInvW, yInvW: d.yInvW, columns: d.columns ? { ...d.columns } : undefined, steps: d.steps.map((st) => ({ sources: st.sources.map((x) => ({ ...x })) })) });

/** Why a line cannot be edited by this release (its values must be told apart by their value sources' presets), or null. */
function lineProblem(l: LineDetail, label: string): string | null {
  if (l.steps.length !== 2) return `${label} has ${l.steps.length} step(s): this release edits lines of 2 steps`;
  if (l.steps.every((st) => st.sources.length === 1 && st.sources[0].attribute === null)) {
    if (l.steps.some((st) => !st.sources[0].preset)) return `${label} has ${l.steps.length} step(s), not all from a preset or hard values on an attribute: this release edits lines of 2 steps, each from a preset or hard values`;
    return null;
  }
  if (l.steps[0].sources.length !== l.steps[1].sources.length) return `${label} has steps with different value sources`;
  const sigs = sigsOf(l.line, presetsIn(l), layoutOf(l), hardIn(l));
  if (!sigs.some(hasPreset)) return `${label} has no value source from a preset or hard values: its values could not be told apart`;
  const bare = sigs.find((g) => !hasPreset(g) && g.attribute === null);
  return bare ? `${label} value source ${bare.source + 1} has neither a preset nor an attribute filter` : null;
}

interface EditArgs extends CreateArgs {
  line?: unknown;
}
const EDIT_ACTIONS = ["set", "add_line", "remove_line"] as const;

export async function editPhaserRecipe(ctx: ToolContext, raw: EditArgs, deps?: RecookDeps): Promise<OperationResult> {
  const op = "edit_phaser_recipe";
  const v = new Validator();
  const action = raw.action as (typeof EDIT_ACTIONS)[number];
  if (!(EDIT_ACTIONS as readonly string[]).includes(String(raw.action))) v.fail(`action must be one of create, ${EDIT_ACTIONS.join(", ")}`);
  const recook = parseRecook(v, raw.recook);
  const target = v.check(() => presetId("preset", raw.preset));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  if (raw.lines !== undefined) v.fail(`lines is for action create; ${action} edits one line`);
  const given = LINE_FIELDS.filter((f) => raw[f] !== undefined);
  const lineNo = raw.line === undefined ? (action === "add_line" ? undefined : 1) : v.check(() => objectNumber("line", raw.line, { max: MAX_LINES }));
  if (action === "add_line" && raw.line !== undefined) v.fail("add_line appends the line after the last one: line is not given");
  if (action === "remove_line" && (given.length || name !== undefined)) v.fail(`remove_line takes preset and line only (got ${[...given, ...(name !== undefined ? ["name"] : [])].join(", ")})`);
  // set: each field is optional; steps is 2 items ({} keeps the step).
  const change: Omit<Partial<LineSpec>, "steps"> & { steps?: StepSpec[] } = {};
  let addSpec: LineSpec | undefined;
  if (action === "set") {
    if (!given.length && name === undefined) v.fail(`set changes at least one of ${LINE_FIELDS.join(", ")}, name`);
    if (raw.selection !== undefined) change.selection = v.check(() => objectNumber("selection", raw.selection, { max: 9999 }));
    if (raw.shape !== undefined) change.shape = v.check(() => objectNumber("shape", raw.shape, { max: 9999 }));
    if (raw.matricks !== undefined) change.matricks = v.check(() => objectNumber("matricks", raw.matricks, { max: 9999 }));
    if (raw.speed_bpm !== undefined) change.speed = v.check(() => finiteNumber("speed_bpm", raw.speed_bpm, { min: 0.01, max: 6000 }));
    if (raw.measure !== undefined) change.measure = v.check(() => finiteNumber("measure", raw.measure, { min: 0.01, max: 1000 }));
    if (raw.phase !== undefined) change.phase = parsePhase(v, raw.phase, "phase");
    if (raw.speed_master !== undefined) change.speedMaster = parseSpeedMaster(v, raw.speed_master, "speed_master");
    if (raw.adaptive_measure !== undefined) change.adaptiveMeasure = parseFlag(v, raw.adaptive_measure, "adaptive_measure");
    if (raw.adaptive_width !== undefined) change.adaptiveWidth = parseFlag(v, raw.adaptive_width, "adaptive_width");
    Object.assign(change, parseMatricksFields(v, raw as Record<string, unknown>, (f) => f));
    if (raw.steps !== undefined) {
      if (!Array.isArray(raw.steps) || raw.steps.length !== 2) v.fail('steps must be exactly 2 items, each {preset? | sources?, curve?, trans?, width?} ({} keeps that step)');
      else change.steps = raw.steps.map((s, i) => parseStep(v, s, `steps[${i}]`, false));
    }
    adaptiveConflicts(v, change, (f) => f);
  } else if (action === "add_line") {
    addSpec = parseLine(v, raw as Record<string, unknown>, "");
  }
  /** Steps reset to the shape's curve (every step given a curve; with add_line every step), then the named curves. */
  const curvePlan = (reqSteps: StepSpec[]) => ({
    resets: reqSteps.flatMap((st, n) => (st.curve !== undefined || action === "add_line" ? [n] : [])),
    named: reqSteps.flatMap((st, n): Array<[number, CurveName]> => (st.curve && st.curve !== "reset" ? [[n, st.curve]] : [])),
  });
  const tgt: Record<string, unknown> = { action: raw.action, preset: raw.preset, ...(lineNo !== undefined ? { line: lineNo } : {}) };
  if (!v.ok || !target) return validationFailure(op, tgt, v.errors);
  const ref = `Preset ${target.pool}.${target.number}`;
  tgt.ref = ref;
  const bridge = ctx.bridge;
  const tm = ctx.requestTimeoutMs;
  const preview = raw.preview === true;

  const body = async (): Promise<OperationResult> => {
    const steps_: StepResult[] = [];
    let plan: string[] = [];
    const fail = (summary: string) => buildResult({ operation: op, target: tgt, steps: steps_, summary, extra: { plan } });
    const read = async (name_: string, fn: () => Promise<string | null>, opName?: string): Promise<boolean> => {
      try {
        const problem = await fn();
        steps_.push(asRead({ name: name_, status: problem ? "failed" : "succeeded", ...(opName ? { op: opName } : {}), ...(problem ? { error: problem } : {}) }));
        return !problem;
      } catch (err) {
        steps_.push(asRead(stepFromError(name_, err, opName ? { op: opName } : {})));
        return false;
      }
    };

    // ---- Checks: nothing is sent unless all pass.
    let before: LineDetail[] = [];
    let rowsBefore: Row[] = [];
    let referencedBy: number | undefined;
    let k = lineNo ?? 0; // the line edited, added or removed
    let want: LineExpect | undefined; // the edited or added line after the edit
    let res: Resolved[][] = []; // what each value source of the edited or added line is given
    let clears: Array<[number, number]> = []; // value sources whose preset is cleared (back to their own value)
    let attrChanges: Array<[number, string | null]> = []; // value sources whose attribute is assigned (or cleared)
    let flagsBefore: Flags = {}; // the line's adaptive flags when its settings are written (after a new shape)
    let masterNames = new Map<number, string>();
    const editNotes: string[] = [];
    const folder = rangeFolder(bridge, tm);
    const lineAt = (n: number) => `${ref}.${n}`;
    const sourceAt = (n: number, step: number, source = 1) => `${ref}.${n}.1.${step}.${source}`;
    const ok =
      (await read("read_target", async () => {
        const ls = await readLineDetails(bridge, ref, tm);
        if (!ls) return `${ref} is not in the show (action create builds a new phaser preset)`;
        const data = await readPreset(bridge, ref, tm);
        if (data?.truncated) return `${ref} was not read completely`;
        before = ls;
        rowsBefore = await folder.fold(data?.rows ?? []);
        referencedBy = data?.referencedBy;
        if (!ls.length) return `${ref} has no recipe line`;
        if (action === "add_line") {
          if (ls.length >= MAX_LINES) return `${ref} already has ${ls.length} lines (at most ${MAX_LINES})`;
          if (ls[0].class !== "PhaserRecipe") return `line 1 of ${ref} is a ${ls[0].class}: a new line is a copy of line 1, a PhaserRecipe`;
          const p = lineProblem(ls[0], `line 1 of ${ref}`);
          if (p) return `${p} (a new line is a copy of line 1)`;
          k = ls.length + 1;
          return null;
        }
        const line = ls[k - 1];
        if (!line) return `${ref} has ${ls.length} line(s), no line ${k}`;
        if (line.class !== "PhaserRecipe") return `line ${k} of ${ref} is a ${line.class}, not a PhaserRecipe`;
        if (action === "remove_line" && ls.length === 1) return `line ${k} is the only line of ${ref}: delete the preset instead`;
        // Its cooked values are told apart by their value sources' presets: the read-back needs them, removal included.
        return lineProblem(line, `line ${k}`);
      }, "children")) &&
      (await read("check_edit", async () => {
        if (action === "remove_line") return null;
        const base = action === "set" ? before[k - 1] : before[0];
        const w = expectOf(base);
        const s = action === "set" ? change : addSpec!;
        const newShape = action === "set" ? s.shape !== undefined : raw.shape !== undefined;
        const shapeChanged = action === "set" ? newShape && s.shape !== base.shape : true;
        const layout = layoutOf(base);
        flagsBefore = { adaptiveMeasure: base.adaptiveMeasure, adaptiveWidth: base.adaptiveWidth };
        // The shape's own value sources: which sources it filters on an attribute (a new line's sources start from them).
        const attrsGiven = givenAttributes(s.steps ?? []).length > 0 || (s.steps ?? []).some((x) => x.attribute === null || (x.sources ?? []).some((y) => y.spec.attribute === null));
        let shapeLayout: Layout | null = null;
        if (action === "add_line" || attrsGiven || (newShape && s.shape !== base.shape)) {
          const sh = newShape ? s.shape! : base.shape;
          shapeLayout = sh === null ? null : await readLayout(bridge, `Shape ${sh}.1`, tm);
          if (!shapeLayout) return `Shape ${sh} is not in the show (or has no phaser recipe)`;
        }
        if (newShape && s.shape !== base.shape) {
          const sl = shapeLayout!;
          if (!fitsLayout(sl, layout)) return `Shape ${s.shape}'s value sources (${layoutText(sl)}) are not ${action === "set" ? `line ${k}'s` : "line 1's"} (${layoutText(layout)}): Assign Shape keeps a line's value sources, so the shape must have the same ones (another layout is a line of its own, made with create)`;
          // A flag the line set itself stays through Assign Shape; one it took from its shape follows the new shape.
          const sf = await readShapeFlags(bridge, s.shape!, tm);
          flagsBefore = { adaptiveMeasure: base.adaptiveMeasureOwn ? base.adaptiveMeasure : sf.adaptiveMeasure, adaptiveWidth: base.adaptiveWidthOwn ? base.adaptiveWidth : sf.adaptiveWidth };
        }
        const stepsGiven: StepSpec[] = s.steps ?? [];
        if (stepsGiven.some(givesWidth) && flagsBefore.adaptiveWidth === true && s.adaptiveWidth !== false)
          return `line ${k} has Adaptive Width (the console sets each width to 100 / phase positions and ignores WIDTHX): give adaptive_width: false to set a width (it changes the look: under Adaptive Width a chase lights one position at a time)`;
        if (s.measure !== undefined && flagsBefore.adaptiveMeasure === true)
          editNotes.push(`line ${k} had Adaptive Measure (the console sets the measure to the number of phase positions: fixtures, or MAtricks positions); measure ${s.measure} switches it off (PLAYBACKADAPTIVEMEASURE No before MEASURE), so one cycle lasts ${s.measure} beat(s) instead of one beat per position`);
        if (typeof s.speedMaster === "number") {
          masterNames = await readMasterNames(bridge, tm);
          const m = masterProblems([s.speedMaster], masterNames);
          if (m.problems.length) return m.problems.join("; ");
          editNotes.push(...m.warnings);
        }
        if (s.selection !== undefined) w.group = s.selection;
        if (newShape) w.shape = s.shape!;
        if (s.matricks !== undefined) w.matricks = s.matricks;
        if (s.speed !== undefined) w.speedHz = s.speed / 60;
        if (s.phase) {
          w.phaseFrom = s.phase.from;
          w.phaseTo = s.phase.to;
        }
        // Transform and the columns: a line with a MAtricks object reads them from it (refused); a new MAtricks object
        // replaces them (not compared). Mirror sets INVERTSTYLE Pan; the inverts follow the transform and the wings.
        if (givesColumns(s) && w.matricks !== null) return matricksColumnsProblem(`line ${k}`, w.matricks);
        if (w.matricks !== base.matricks) Object.assign(w, { transform: undefined, invertStyle: undefined, xInvW: undefined, yInvW: undefined, columns: undefined });
        if (s.columns) w.columns = { ...w.columns, ...s.columns };
        if (s.transform !== undefined) w.transform = s.transform === "mirror" ? "Mirror" : "None";
        if (s.transform === "mirror") w.invertStyle = "Pan";
        if (s.invertStyle) w.invertStyle = INVERT_STYLES[s.invertStyle];
        if (s.transform !== undefined || (w.transform === "Mirror" && (s.columns?.XWINGS !== undefined || s.columns?.YWINGS !== undefined))) Object.assign(w, derivedInverts(w.transform, w.columns));
        if (givesColumns(s)) editNotes.push(...mirrorWithoutWings(`line ${k}`, w));
        if (action === "add_line" && s.transform === undefined && w.transform === "Mirror")
          editNotes.push(`line ${k} is a copy of line 1 and keeps its Transform Mirror (and its columns): give transform: "none" to leave it unmirrored`);
        const reqSteps: StepSpec[] = s.steps ?? [{}, {}];
        const r = resolveSteps(reqSteps, layout, `line ${k}`);
        if (r.errors.length) return r.errors.join("; ");
        res = r.res;
        const attrProblems = shapeLayout ? attributeProblems(`line ${k}`, shapeLayout, res) : [];
        if (attrProblems.length) return attrProblems.join("; ");
        // Attributes: given; else kept (set) or, on a copy of line 1 (add_line), the shape's. One per source, both steps.
        attrChanges = [];
        (layout[0] ?? []).forEach((x, s_) => {
          const given = res[0]?.[s_]?.attribute;
          const want_ = given !== undefined ? given : action === "add_line" ? (shapeLayout?.[0]?.[s_]?.attribute ?? null) : x.attribute;
          for (const st of w.steps) if (st.sources[s_]) st.sources[s_].attribute = want_;
          if (want_ === null || x.attribute === null ? want_ !== x.attribute : !eqi(want_, x.attribute)) attrChanges.push([s_, want_]);
        });
        // Presets and hard values: given; else kept (set) or, on a copy of line 1 (add_line), cleared back to the
        // source's own value. Hard values are kept by a copy and nothing takes them back to the shape's: refused.
        clears = [];
        const baseHard = hardIn(base);
        const valueProblems: string[] = [];
        res.forEach((st, n) =>
          st.forEach((x, s_) => {
            const ws = w.steps[n].sources[s_];
            const at = `line ${k} step ${n + 1} ${sourceName(layout, s_)}`;
            if (isHard(x)) Object.assign(ws, { preset: null, absolute: x.absolute ?? null, relative: x.relative ?? null });
            else if (x.preset) Object.assign(ws, { preset: x.preset, absolute: null, relative: null });
            else if (x.preset === null || action === "add_line") {
              if (isHard(baseHard[n]?.[s_])) valueProblems.push(`${at} holds hard values${action === "add_line" ? " on line 1 (the copy keeps them)" : ""}: no command takes them back to the shape's value; give a preset or hard values`);
              if (base.steps[n].sources[s_].preset) clears.push([n, s_]);
              ws.preset = null;
            }
          }),
        );
        if (valueProblems.length) return valueProblems.join("; ");
        // Curves: a new shape recomputes them (a custom curve survives, not knowable here) and some trans / widths and
        // the measure. Every step given a curve is reset to the shape's first (a named curve over a Snap would keep its
        // TRANS 0), every step of a new line too (a copy keeps line 1's custom curves); then the named curves. Reset
        // values are the shape's: not compared.
        if (shapeChanged) {
          w.steps.forEach((st) => st.sources.forEach((x) => Object.assign(x, { accel: undefined, decel: undefined, trans: undefined, width: undefined })));
          w.measure = undefined;
        }
        const cp = curvePlan(reqSteps);
        cp.resets.forEach((n) =>
          w.steps[n].sources.forEach((x, s_) => {
            Object.assign(x, { decel: undefined, trans: undefined });
            w.steps[(n + 1) % 2].sources[s_].accel = undefined;
          }),
        );
        cp.named.forEach(([n, c]) => {
          const cv = CURVES[c];
          w.steps[n].sources.forEach((x, s_) => {
            x.decel = cv.decel;
            x.trans = "trans" in cv ? cv.trans : 100;
            w.steps[(n + 1) % 2].sources[s_].accel = cv.nextAccel;
          });
        });
        // Width, then trans. With Link Steps the other step's width takes the rest of the sum; a width may move the trans.
        res.forEach((st, n) =>
          st.forEach((x, s_) => {
            if (x.width === undefined) return;
            const o = (n + 1) % 2;
            const a = base.steps[n].sources[s_].width;
            const b = base.steps[o].sources[s_].width;
            w.steps[n].sources[s_].width = x.width;
            const awChanged = (s.adaptiveWidth ?? flagsBefore.adaptiveWidth) !== base.adaptiveWidth;
            w.steps[o].sources[s_].width = !shapeChanged && !awChanged && a !== undefined && b !== undefined ? a + b - x.width : undefined;
            w.steps[n].sources[s_].trans = undefined;
            w.steps[o].sources[s_].trans = undefined;
          }),
        );
        res.forEach((st, n) => st.forEach((x, s_) => x.trans !== undefined && (w.steps[n].sources[s_].trans = x.trans)));
        // Adaptive flags after the edit: written, else as before (a new shape: its own, unless the line set them itself).
        w.adaptiveMeasure = s.measure !== undefined ? false : (s.adaptiveMeasure ?? flagsBefore.adaptiveMeasure);
        w.adaptiveWidth = s.adaptiveWidth ?? flagsBefore.adaptiveWidth;
        // Under Adaptive Measure / Width the console derives the measure and the widths from the phase positions: a new
        // group or MAtricks moves them, and so does switching a flag (Chase, live 2026-11-14: measure 4 = 4 fixtures, 2
        // with XWings 2; widths 25 / 75, 100 / 100 once Adaptive Width is off). Those are not compared.
        const positionsMoved = s.selection !== undefined || s.matricks !== undefined || shapeChanged || movesPositions(s.columns);
        const amToggled = w.adaptiveMeasure !== base.adaptiveMeasure;
        const awToggled = w.adaptiveWidth !== base.adaptiveWidth;
        if ((w.adaptiveMeasure !== false && positionsMoved) || amToggled) w.measure = undefined;
        if ((w.adaptiveWidth !== false && positionsMoved) || awToggled)
          w.steps.forEach((st, n) => st.sources.forEach((x, s_) => res[n]?.[s_]?.width === undefined && Object.assign(x, { width: undefined })));
        if (s.measure !== undefined) w.measure = s.measure;
        if (s.speedMaster !== undefined) w.speedMaster = s.speedMaster === null ? "" : (masterNames.get(s.speedMaster) ?? "");
        want = w;
        return null;
      })) &&
      (await read("check_references", async () => {
        if (!want) return null;
        const refs = [`Group ${want.group}`, `Shape ${want.shape}`, ...(want.matricks !== null ? [`MAtricks ${want.matricks}`] : [])];
        const missing: string[] = [];
        for (const r of refs) if (!(await exists(bridge, r, tm))) missing.push(r);
        const presetRows = new Map<string, Row[]>();
        for (const p of new Set(presetsIn(want).flat().filter((x): x is PresetRef => !!x).map(pkey))) {
          const d = await readPreset(bridge, `Preset ${p}`, tm);
          if (!d) missing.push(`Preset ${p}`);
          else presetRows.set(p, d.rows ?? []);
        }
        missing.push(...(await missingAttributes(bridge, givenAttributes((action === "set" ? change.steps : addSpec?.steps) ?? []), tm)));
        if (missing.length) return `not in the show: ${missing.join(", ")}`;
        const layout = layoutOf(want);
        const problems = sourceProblems(`line ${k}`, presetsIn(want), layout, target, presetRows, hardIn(want));
        if (problems.length) return problems.join("; ");
        const mine = sigsOf(k, presetsIn(want), layout, hardIn(want), { group: want.group, matricks: want.matricks });
        for (const l of before) {
          if (l.line === k && action === "set") continue;
          if (l.class !== "PhaserRecipe") continue;
          const theirs = sigsOf(l.line, presetsIn(l), layoutOf(l), hardIn(l), { group: l.group, matricks: l.matricks });
          const c = mine.find((g) => theirs.some((h) => clash(g, h)));
          if (c) {
            const kind = c.pair.split("/").some(isHardKey) ? "values" : "presets";
            return `line ${l.line} already has the step ${kind} ${c.pair}${c.attribute ? ` on ${c.attribute}` : ""} on the same selection (${selectionText(c.selection)}): two identical lines would cook the same values twice (another group or MAtricks is allowed: the same steps on lines of other groups are told apart by their fixtures)`;
          }
        }
        return null;
      })) &&
      (await read("read_edit_state", async () => {
        const s = await readEditState(bridge, tm);
        if (s.modalError) return `whether a dialog is open cannot be read (${s.modalError})`;
        if (s.modal) return `a dialog is open (${s.modal.title ?? "untitled"}): answer it first`;
        if (s.editing) return "the Edit Recipe mode is on: switch it off first";
        return null;
      }, "recipe.editState"));

    // ---- The actions, in order: retarget, value source presets, cleared presets, curves (after the shape: a new shape
    // recomputes them), widths and trans, speed / phase / measure, name.
    const actions: Action[] = [];
    if (action === "remove_line") actions.push({ kind: "cmd", command: `Delete ${lineAt(k)} /NoConfirmation` });
    else if (want) {
      const base = action === "set" ? before[k - 1] : before[0];
      const s = action === "set" ? change : addSpec!;
      const cmdA = (command: string): Action => ({ kind: "cmd", command });
      if (action === "add_line") actions.push(cmdA(`Copy ${lineAt(1)} At ${lineAt(k)} /NoConfirmation`));
      if (want.group !== base.group) actions.push(cmdA(`Assign Group ${want.group} At ${lineAt(k)}`));
      if (want.shape !== base.shape) actions.push(cmdA(`Assign Shape ${want.shape} At ${lineAt(k)}`));
      if (want.matricks !== base.matricks) actions.push(cmdA(`Assign MAtricks ${want.matricks} At ${lineAt(k)}`));
      for (const [s_, a] of attrChanges) actions.push(attributeAction(sourceAt(k, 1, s_ + 1), a));
      res.forEach((st, n) => st.forEach((x, s_) => x.preset && actions.push(cmdA(`Assign Preset ${pkey(x.preset)} At ${sourceAt(k, n + 1, s_ + 1)}`))));
      for (const [n, s_] of clears) actions.push({ kind: "set", ref: sourceAt(k, n + 1, s_ + 1), property: "PRESET", value: "", expect: "empty" });
      res.forEach((st, n) => st.forEach((x, s_) => isHard(x) && actions.push(...hardActions(sourceAt(k, n + 1, s_ + 1), x, !!base.steps[n].sources[s_].preset))));
      // The line's settings: the adaptive flags now (before the widths), the rest (speed, phase, measure, master) last.
      const settings = lineSettings(lineAt(k), s, masterNames, flagsBefore);
      const isFlag = (a: Action) => a.kind === "set" && a.property.startsWith("PLAYBACKADAPTIVE");
      actions.push(...settings.filter(isFlag));
      const reqSteps: StepSpec[] = s.steps ?? [{}, {}];
      const cp = curvePlan(reqSteps);
      const count = base.steps[0]?.sources.length ?? 1;
      for (const n of cp.resets) for (let x = 1; x <= count; x++) actions.push(cmdA(`Set ${sourceAt(k, n + 1, x)} Property "Curve" "Reset"`));
      for (const [n, c] of cp.named) for (let x = 1; x <= count; x++) actions.push(cmdA(`Set ${sourceAt(k, n + 1, x)} Property "Curve" "${curveConsole(c)}"`));
      actions.push(...sourceSettings((step, source) => sourceAt(k, step, source), res));
      actions.push(...settings.filter((a) => !isFlag(a)));
    }
    plan = [...actions.map(actionText), ...(name !== undefined ? [`set ${ref} Name=${name}`] : []), `Cook ${ref} /MergeLowPriority`];
    if (!ok) return fail(`${op} was not performed; nothing was sent: ${steps_.find((s) => s.status !== "succeeded")?.error ?? "a check failed"}`);
    if (preview) {
      // recook: the calling cue parts the call would re-cook (a read-only scan).
      const rc = recook ? await recookCallers(ctx, { preset: target, presetRead: null, spec: recook, preview: true }, deps) : undefined;
      if (rc) plan.push(`then re-cook (${recook!.mode}) each calling cue part in ${rc.report.scope}: ${rc.report.wouldRecook?.join(", ") || "none found"}`);
      return buildResult({ operation: op, target: tgt, steps: [...steps_, ...(rc?.steps ?? [])], summary: "Preview only; nothing was sent.", ...(rc?.warnings.length ? { warnings: rc.warnings } : {}), extra: { plan, preview: true, before: before[k - 1] ?? null, ...(rc ? { recook: rc.report } : {}) } });
    }

    // ---- Send. A failed command stops the edit (nothing is undone); a failed setting is reported. The preset is cooked and read back either way.
    const notDone: string[] = [];
    let stopped = false;
    let n_ = 0;
    for (const a of actions) {
      n_++;
      const s = await runAction(bridge, a.kind === "cmd" ? `edit_${n_}` : `set_${a.property.toLowerCase()}`, a, tm);
      steps_.push(s);
      if (s.status !== "succeeded") {
        if (a.kind === "cmd") {
          stopped = true;
          notDone.push(`"${a.command}" and what follows it`);
          break;
        }
        notDone.push(`${a.ref} ${a.property}`);
        continue;
      }
      if (action === "add_line" && n_ === 1) {
        const n = await readLines(bridge, { kind: "preset", pool: target.pool, number: target.number }, tm).catch(() => null);
        const good = n?.length === k && n[k - 1]?.class === "PhaserRecipe";
        steps_.push(asRead({ name: "line_copied", status: good ? "succeeded" : "failed", op: "children", ...(good ? {} : { error: `${ref} has ${n?.length ?? "an unknown number of"} line(s) after the copy, ${k} expected` }) }));
        if (!good) {
          stopped = true;
          notDone.push("the new line's settings");
          break;
        }
      }
    }
    if (!stopped && name !== undefined) {
      try {
        const r = (await bridge.request("set", { ref, property: "Name", value: name }, tm)) as { value?: unknown };
        const good = String(r?.value ?? "") === name;
        steps_.push({ name: "label", status: good ? "succeeded" : "failed", op: "set", ...(good ? {} : { error: `Name reads ${JSON.stringify(r?.value)}` }) });
        if (!good) notDone.push("name");
      } catch (err) {
        steps_.push(stepFromError("label", err, { op: "set" }));
        notDone.push("name");
      }
    }
    const cookStep = await commandStep(bridge, "cook", `Cook ${ref} /MergeLowPriority`, tm);
    steps_.push(cookStep);

    // ---- Read back: the edited line as asked, every other line and its cooked values unchanged.
    let verification: Verification = notRequested();
    let after: LineDetail[] | null = null;
    let presetAfter: PresetRead | null = null;
    let ambiguousLines: string[] = [];
    try {
      after = (await readLineDetails(bridge, ref, tm)) ?? [];
      const data = await readPreset(bridge, ref, tm);
      presetAfter = data; // raw: the re-cook compares it with the cues' cooked values
      const s = await readEditState(bridge, tm);
      const rows = await folder.fold(data?.rows ?? []);
      const problems: string[] = [];
      const expected: Array<{ label: string; want: LineExpect }> = before.map((l) => ({ label: `line ${l.line}`, want: expectOf(l) }));
      if (action === "set") expected[k - 1].want = want!;
      if (action === "add_line") expected.push({ label: `line ${k}`, want: want! });
      if (action === "remove_line") expected.splice(k - 1, 1);
      if (after.length !== expected.length) problems.push(`${ref} has ${after.length} line(s), ${expected.length} expected`);
      expected.forEach((e, i) => {
        const label = action === "remove_line" && i >= k - 1 ? `${e.label} (now line ${i + 1})` : e.label;
        problems.push(...lineDiff(label, after![i], e.want));
      });
      // Cooked values: the edited line's value sources have values at its speed; the old presets' are gone; every other value unchanged.
      // A Mirror line (as read, before and after) also owns its mirrored values on its group (see MirrorScope).
      const groups = new Map<number, GroupInfo>();
      const oldSigs = action === "add_line" ? [] : await withMirror(bridge, tm, sigsOf(k, presetsIn(before[k - 1]), layoutOf(before[k - 1]), hardIn(before[k - 1]), { group: before[k - 1].group, matricks: before[k - 1].matricks }), before[k - 1], groups);
      const newSigs = want ? await withMirror(bridge, tm, sigsOf(k, presetsIn(want), layoutOf(want), hardIn(want), { group: want.group, matricks: want.matricks }), after[k - 1] && { ...after[k - 1], group: want.group }, groups) : [];
      const otherSigs = before.filter((l) => l.line !== k || action === "add_line").flatMap((l) => (l.class === "PhaserRecipe" ? sigsOf(l.line, presetsIn(l), layoutOf(l), hardIn(l), { group: l.group, matricks: l.matricks }) : []));
      // A line with twins (the same steps on another group): its values are those on its group's fixtures.
      ambiguousLines = await scopeTwins(bridge, tm, [...oldSigs, ...newSigs, ...otherSigs], groups);
      const overlaps = (a: Sig, b: Sig) => !a.members || !b.members || [...a.members].some((x) => b.members!.has(x));
      const shared = (g: Sig) => otherSigs.some((h) => clash(g, h) || (twins(g, h) && overlaps(g, h)));
      // The line's own values; a mirrored value only when no other line's own values match it.
      const ofLine = (r: Row, sigs: Sig[]) => sigs.some((g) => straightMatch(r, g)) || (sigs.some((g) => mirrorMatch(r, g)) && !otherSigs.some((h) => straightMatch(r, h)));
      // A fixture and attribute the edited line output, before or after, is left out: there one line masks another
      // (the later line wins), so another line's value may rightly appear or go.
      const covered = new Set([...rowsBefore.filter((r) => ofLine(r, oldSigs)), ...rows.filter((r) => ofLine(r, newSigs))].map((r) => `${r.fixture}|${r.attribute}`));
      const mine = (r: Row) => ofLine(r, oldSigs) || ofLine(r, newSigs) || covered.has(`${r.fixture}|${r.attribute}`);
      const othersBefore = counts(rowsBefore.filter((r) => !mine(r)));
      const othersAfter = counts(rows.filter((r) => !mine(r)));
      const changed = [...new Set([...othersBefore.keys(), ...othersAfter.keys()])].filter((key) => othersBefore.get(key) !== othersAfter.get(key));
      if (changed.length) problems.push(`${changed.length} value(s) of the other lines changed (first: ${changed[0].split("|").slice(0, 3).join(" ")})`);
      const uncookedBefore = rowsBefore.filter((r) => r.cooked !== true).length;
      const uncooked = rows.filter((r) => r.cooked !== true).length;
      if (uncooked > uncookedBefore) problems.push(`${ref} holds ${uncooked} uncooked value(s), ${uncookedBefore} before`);
      if (data?.truncated) problems.push(`${ref} was not read completely`);
      const multi = (want ?? expectOf(before[k - 1] ?? before[0])).steps.some((st) => st.sources.length > 1);
      for (const g of oldSigs) {
        if (!hasPreset(g) || newSigs.some((h) => h.pair === g.pair && h.attribute === g.attribute) || shared(g)) continue;
        const stale = rows.filter((r) => rowMatches(r, g, true));
        if (stale.length) problems.push(`${stale.length} cooked value(s) still come from the old step presets ${g.pair}${multi ? ` (${g.attribute ?? `source ${g.source + 1}`})` : ""}`);
      }
      if (want) {
        for (const g of newSigs.filter(hasPreset)) {
          // Evidence: the line's own step presets or hard values; the values checked: those and its mirrored ones.
          const got = rows.filter((r) => ofLine(r, [g]));
          if (!rows.some((r) => rowMatches(r, g, true))) {
            problems.push(`no cooked value comes from line ${k}${multi ? ` ${g.attribute ?? `source ${g.source + 1}`}` : ""} (${sigText(g)})`);
            continue;
          }
          if (shared(g)) continue;
          if (want.speedHz !== undefined) {
            const off = got.filter((r) => typeof r.speed !== "number" || Math.abs(r.speed - want!.speedHz!) > 0.001);
            if (off.length) problems.push(`line ${k}: ${off.length} cooked value(s) do not run at ${+(want.speedHz * 60).toFixed(3)} BPM`);
          }
          const m = action === "set" ? change.measure : addSpec?.measure;
          if (m !== undefined) {
            const off = got.filter((r) => typeof r.measure !== "number" || Math.abs(r.measure / 100 - m) > 0.01);
            if (off.length) problems.push(`line ${k}: ${off.length} cooked value(s) do not have Measure ${m}`);
          }
          const sm = action === "set" ? change.speedMaster : addSpec?.speedMaster;
          if (sm !== undefined) problems.push(...cookedMasterDiff(`line ${k}`, got, sm));
        }
      }
      if (s.modal) problems.push(`a dialog is open (${s.modal.title ?? "untitled"})`);
      steps_.push(asRead({ name: "read_back", status: "succeeded", op: "children" }));
      const what = `${ref}: ${action === "remove_line" ? `line ${k} removed, the later lines moved up` : `line ${k} ${action === "add_line" ? "added" : "edited"} (group, shape, MAtricks, value source presets, speed, phase, measure, curves, trans / width set)`}, the other lines and their cooked values unchanged, the edited line's values cooked`;
      verification = problems.length ? { status: "mismatched", checked: what, detail: problems.join("; ") } : { status: "matched", checked: what };
    } catch (err) {
      steps_.push(asRead(stepFromError("read_back", err, { op: "children" })));
    }
    const warnings: string[] = [...editNotes, ...folder.finish()];
    if (ambiguousLines.length) warnings.push(ambiguousNote(ambiguousLines));
    if (notDone.length) warnings.push(`not done as asked: ${notDone.join(", ")} (nothing was undone)`);
    const edited = action !== "remove_line" ? after?.[k - 1] : undefined;
    if (edited?.speedMaster) warnings.push(...masterSpeedWarning(`line ${k}`, edited.speedMaster, edited.speedHz));
    if (want && action === "set" && change.shape !== undefined) warnings.push("a new shape recomputes the curves of steps without a custom curve; a custom curve stays (give curve: reset to go back to the shape's)");
    // ---- The calling cues: re-cooked (recook), or a warning that they still hold the old cooked values.
    let recookReport: RecookReport | undefined;
    if (recook) {
      const editOk = cookStep.status === "succeeded" && verification.status === "matched" && !notDone.length;
      const rc = await recookCallers(ctx, { preset: target, presetRead: presetAfter, spec: recook, ...(editOk ? {} : { skipAll: `not re-cooked: the edit of ${ref} did not ${cookStep.status === "succeeded" ? "read back as asked" : "cook"}` }) }, deps);
      steps_.push(...rc.steps);
      warnings.push(...rc.warnings);
      recookReport = rc.report;
      const n = rc.report.recooked.length;
      if (recook.sequences) warnings.push(`only Sequence(s) ${recook.sequences.join(", ")} were searched for cues calling ${ref}: a cue in another sequence was not re-cooked${referencedBy ? ` (${referencedBy} object(s) reference ${ref}, the console's count before the edit)` : ""}`);
      if (editOk) {
        const checked = `${verification.checked}; ${n} calling cue part(s) in ${rc.report.scope} re-cooked (${recook.mode}) and read back: their cooked values from ${ref} match the preset's, OwnNonCookedDataPresent No, the cue's other parts unchanged${rc.report.complete ? "" : " (the search for callers was incomplete)"}`;
        verification = rc.problems.length ? { status: "mismatched", checked, detail: rc.problems.slice(0, 12).join("; ") } : { status: "matched", checked };
      }
    } else if (referencedBy !== 0) {
      warnings.push(`the cues that call ${ref} were NOT re-cooked: they may keep their old cooked values (a bench saw a cue keep the old width, trans or speed until re-cooked): ${referencedBy ? `${referencedBy} object(s) reference ${ref} (the console's count)` : "the console's reference count was not read"}. Pass recook: true (or {sequences: [...]}), or cook each calling cue part with gma3_cook_recipes (gma3_preset_usage finds them)`);
    }
    const notes = ["a cue line with its own Speed X (SPEEDFROMX not None) keeps that speed after a re-cook"];
    if (clears.length && want) notes.push(`value sources given no preset now output the shape's own value: ${clears.map(([n, s_]) => `step ${n + 1} ${want!.steps[n].sources[s_].attribute ?? `source ${s_ + 1}`}`).join(", ")}`);
    return buildResult({ operation: op, target: tgt, steps: steps_, verification, ...(warnings.length ? { warnings } : {}), extra: { plan, notes, before: action === "add_line" ? null : before[k - 1] ?? null, lines: after, ...(recookReport ? { recook: recookReport } : {}) } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

const sourceSchema = z.union([
  z.string().describe('Preset "P.X" for this value source.'),
  z.null().describe("No preset: the value source outputs its own value (the shape's). set: clears the source's preset."),
  z.object({
    preset: z.string().nullable().optional().describe('Preset "P.X" (null: the shape\'s own value; set: omit to keep the source\'s).'),
    attribute: z.string().nullable().optional().describe('The source\'s attribute ("Tilt", "Dimmer", "ColorRGB_B"): needed for hard values on a source the shape does not filter; one per source (both steps). set: null clears it (a plain shape\'s source only).'),
    absolute: z.number().optional().describe("Hard absolute value, percent 0-100 (VALUEABSOLUTE), instead of a preset."),
    relative: z.number().optional().describe("Hard relative value, percent of the attribute's WHOLE range, -100 to 100 (VALUERELATIVE; Tilt 180 degrees: 20 = 36 degrees), instead of a preset. On an inverted physical range (PhysicalFrom > PhysicalTo, e.g. Esprite / LEDBeam Tilt) the console cooks it with the opposite sign (live 2026-11-16): the recipe keeps what you send, the read-back expects the opposite cooked sign and says so in a warning."),
    trans: z.number().optional().describe("Trans X of this value source, percent (0-100)."),
    width: z.number().optional().describe("Width X of this value source, percent; with Link Steps the other step's width takes the rest of the source's sum, so give it on one step only."),
  }),
]);
const stepSchema = z.object({
  preset: z.string().optional().describe('Step preset "P.X": a shape with one value source per step (Sine, Ramp...). create / add_line: preset, sources or hard values are required; set: omit them to keep the step\'s.'),
  attribute: z.string().nullable().optional().describe('A shape with one value source: the source\'s attribute ("Tilt"), for hard values (and it filters a preset); one per source, so giving it on one step sets both. set: null clears it.'),
  absolute: z.number().optional().describe("A shape with one value source: hard absolute value, percent 0-100, instead of a preset (needs the attribute)."),
  relative: z.number().optional().describe("A shape with one value source: hard relative value, percent of the attribute's whole range (-100 to 100), instead of a preset (needs the attribute)."),
  sources: z
    .record(z.string(), sourceSchema)
    .optional()
    .describe('A preset per value source of a shape with several (Flyout 19 / Flyout Inverted 20: Dimmer, Tilt, Pan), keyed by the source\'s attribute or number: {Dimmer: "1.9020", Tilt: "2.9020"}. Each preset goes into the source filtered on its attribute; a source not given keeps the shape\'s value (create, add_line) or its own (set).'),
  curve: z.enum(CURVE_CHOICES).optional().describe("Step curve, on every value source of the step (default: the shape's; reset: back to the shape's). With Link Steps it shapes the move from this step to the next. A named curve sets the step's Trans to 100 (Snap: 0): give trans to keep another."),
  trans: z.number().optional().describe("Trans X, percent (0-100), for every value source of the step that does not set its own."),
  width: z.number().optional().describe("Width X, percent, for every value source of the step that does not set its own (one step only: Link Steps keeps a source's 2 widths at their sum)."),
});
const lineShape = {
  selection: z.number().describe("Group number."),
  shape: z.number().optional().describe("Shape pool number (default 1)."),
  steps: z.array(stepSchema).describe("Exactly 2 steps, in order. A value source's 2 presets come from one preset pool."),
  matricks: z.number().optional().describe("MAtricks pool number (wings, blocks... spread the phase)."),
  speed_bpm: z.number().optional().describe("Speed X in BPM (60 BPM = 1 Hz); the console default otherwise (lines 2+ otherwise keep line 1's)."),
  phase: z.object({ from: z.number(), to: z.number() }).optional().describe("Phase X from/to in degrees (e.g. 0 to 360)."),
  measure: z.number().optional().describe("Measure in beats (the line's MEASURE; Flyout reads 4); the shape's otherwise (lines 2+ otherwise keep line 1's). On a line with Adaptive Measure (Chase 7) it switches Adaptive Measure off first: the console ignores MEASURE under it."),
  speed_master: z
    .number()
    .int()
    .min(0)
    .max(MAX_MASTER)
    .nullable()
    .optional()
    .describe("Speed master 1-16 the line follows (SPEEDMASTEROVERRIDE, always written as a number; read back by the master's name and in the cooked values). 0 or null clears the link; text is refused (None would link master 1, a name another master). The master multiplies Speed X: a line that follows a master has Speed X 60 (one cycle = Measure x 60 / master BPM); another Speed X is warned about. Lines 2+ and add_line otherwise keep line 1's; set keeps the line's."),
  adaptive_measure: z.boolean().optional().describe("Adaptive Measure of the line (PLAYBACKADAPTIVEMEASURE; Chase 7 has it: measure = the number of phase positions, i.e. fixtures or MAtricks positions, one beat each). Default: the shape's; a measure switches it off."),
  adaptive_width: z.boolean().optional().describe("Adaptive Width of the line (PLAYBACKADAPTIVEWIDTH; Chase 7 has it: step 1 width = 100 / positions, one position lit at a time). Default: the shape's. A width on a line under Adaptive Width is refused unless adaptive_width is false (the console ignores WIDTHX under it, and switching it off changes the look)."),
  transform: z
    .enum(["none", "mirror"])
    .optional()
    .describe("PHASERTRANSFORM of the line. mirror: on the second wing the values run the other way (absolute 100 - x, relative -x), only on the attributes invert_style names (the console sets it to Pan); it needs wings (x: {wings: 2}): Mirror switches XInvW on with XWings (YInvW with YWings), without wings nothing is mirrored. The mirrored values cook as hard values without the step preset (the cue stays in recipe). none: switches the inverts off. Lines 2+ and add_line otherwise keep line 1's."),
  invert_style: z.enum(["pan", "tilt", "pan_tilt", "all"]).optional().describe("INVERTSTYLE: the attributes Mirror acts on (Pan, Tilt, P+T, All). Mirror sets Pan; give tilt for a Tilt line. Written after transform."),
  x: z
    .object({ wings: z.number().nullable().optional(), blocks: z.number().nullable().optional(), groups: z.number().nullable().optional() })
    .strict()
    .optional()
    .describe("The line's own X MAtricks columns XWINGS / XBLOCK / XGROUP (0 or null: None). Not with a MAtricks object (matricks): the line reads them from it."),
  y: z
    .object({ wings: z.number().nullable().optional(), blocks: z.number().nullable().optional(), groups: z.number().nullable().optional() })
    .strict()
    .optional()
    .describe("The line's own Y columns YWINGS / YBLOCK / YGROUP (0 or null: None); Y follows the group's grid."),
  phase_y: z.object({ from: z.number(), to: z.number() }).nullable().optional().describe("Phase Y from/to in degrees (PHASEFROMY / PHASETOY; adds to phase X along the group's grid Y); null: None."),
};

export const registerPhaserRecipeTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_edit_phaser_recipe",
    {
      title: "Build or edit phaser recipe lines in a preset",
      description:
        "action create: builds PhaserRecipe lines (each: selection group, shape, 2 steps from presets or hard values with an optional curve, trans and width, MAtricks, speed, phase, measure) in a FREE preset slot. One line: give its fields at the top level; several (e.g. Dimmer + Colour in one preset): lines: [{...}, ...] (1-8). " +
        "A step is {preset} for a shape with one value source per step (Sine...), or {sources: {Attribute: \"P.X\", ...}} for a shape with several (Flyout 19 / Flyout Inverted 20: Dimmer, Tilt, Pan, so one line carries Dimmer + Tilt): each preset goes into the value source filtered on its attribute (or named by number), a source not given keeps the shape's value; a source may be {preset?, trans?, width?}. One preset on a multi-source shape is refused (At Preset would put it into every source). " +
        "Hard values instead of presets: a step (or a value source) {attribute, absolute? | relative?}: the attribute is assigned once per source (Assign Attribute, shared by both steps), a preset on the source is cleared, the values are set from the command line (Set ... Property \"ValueAbsolute\" / \"ValueRelative\"; the layer not given is set to None); relative is percent of the attribute's whole range; a step may give only the attribute (it keeps the shape's value). Without an attribute or a preset a line does not cook (refused). A copy keeps line 1's hard values and nothing takes them back to the shape's: a line 2+ / add_line source must then be given a preset or values. " +
        "A value source's 2 presets come from one preset pool; one family per line is preferred (a warning names a line with presets from an All pool). The target preset may be in any pool: the pool does not filter recipe lines. " +
        "Checked first, nothing sent otherwise: the slot is free, the groups, shapes, presets and MAtricks exist, each shape has 2 steps and lines 2+ have line 1's value sources, each source's preset holds its attribute, no two lines on the same selection (Group and MAtricks) share a source's step presets (the same steps on lines of other groups are allowed: a preset split by family or group; the read-back tells them apart by their group's fixtures), the Edit Recipe mode is off with an empty Part Zero, no dialog is open, the programmer is empty (read completely), RecipeStoreMode is Normal. " +
        "Line 1: an empty Store of the preset (it clears the pending Edit Recipe target, so \"Update last object?\" does not open), EditRecipe queued without blocking the bridge (if \"Update last object?\" opens anyway it is answered Cancel, never OK, and the call stops), Group / At Shape / Step / At Preset (only for one preset per step) / MAtricks one command at a time with the line checked in Part Zero, Store /Merge, the mode switched off and read back, ClearAll (line 1 runs on stage from At Shape until then). A failure up to here switches the mode off, clears the programmer and deletes the preset this call created. " +
        "Then the name; line 1's value sources (Assign Preset At <line>.1.<step>.<source>); lines 2+ as copies of line 1 (Copy, then Assign of their group, shape, MAtricks and value source presets; a source given nothing loses line 1's preset; what they do not set is line 1's); SPEEDX / PHASEFROMX / PHASETOX / MEASURE per line; curves (Set ... Property \"Curve\") on every source of the step; WIDTHX then TRANSX per source; Cook /MergeLowPriority. " +
        "Read back: the line count, each line's group, MAtricks and cook state, every value cooked and integrating one value source's step presets, each source with a preset has values, each line's speed, measure, curves, trans and width in the cooked steps, nothing uncooked, mode off, programmer and Part Zero empty. " +
        "The preset then stays the pending Edit Recipe target: a manual EditRecipe elsewhere opens \"Update last object?\" (never OK). Never Store an empty programmer into an existing phaser preset: that wipes its lines. " +
        "The cue calls the preset with a standard line (gma3_store_recipe_cues); a cue line's Speed X replaces the preset's speed. " +
        "Editing an existing phaser preset, without the programmer or the Edit Recipe mode (no exclusive needed): action set changes line `line` (default 1): selection, shape (same value sources only), matricks, speed_bpm, phase, measure, steps [{preset? | sources?, curve?, trans?, width?}, ...] ({} keeps a step; in sources a source not given is kept, null clears its preset back to the shape's value), name; " +
        "add_line appends a copy of line 1 retargeted with the given fields (selection and steps required; shape, MAtricks, speed, phase and measure otherwise line 1's; steps without a curve are reset to the shape's; a source given nothing loses line 1's preset); remove_line deletes line `line` (the later lines move up; never the only line). " +
        "Checked first: the preset and line exist, the line is a PhaserRecipe of 2 steps whose values are told apart by their value sources' presets or hard values, each source's presets from one pool and holding its attribute, no other line on the same selection (Group and MAtricks) with the same source presets (another group or MAtricks is allowed), the references exist, no dialog, the Edit Recipe mode off. " +
        "Sent: Assign Group / Shape / MAtricks At the line, Assign Preset At each value source, set PRESET \"\" on a cleared source, the curves after the shape, WIDTHX / TRANSX, SPEEDX / PHASEFROMX / PHASETOX / MEASURE, Cook /MergeLowPriority. " +
        "Read back: the edited line as asked (presets, trans, width per source, curves, measure, cook state), every other line and its cooked values unchanged, the edited line's values cooked at its speed and measure, the old presets' values gone. " +
        "Cues calling the preset are not guaranteed to follow the edit (a bench saw a cue keep the old width, trans or speed until re-cooked; another saw it follow at once): re-cook them. recook: true (or {sequences: [...], mode}) on set / add_line / remove_line, after a matched edit: finds the cue parts that call the preset (gma3_preset_usage's scan: every sequence, or only those listed; give sequences on a large show), re-cooks each part whose recipe line calls it with gma3_cook_recipes (merge_low_priority by default, or merge; one part at a time, never the whole cue), and reads each back: its cooked values from the preset match the preset's (steps, presets, trans, width, curves, phase, measure, speed master; speed unless the cue line has its own Speed X), OwnNonCookedDataPresent No, the cue's other parts unchanged. recook lists the parts re-cooked and those skipped with the reason (values referencing the preset without a recipe line calling it); not searched: presets that embed it, CueZero, OffCue. Without recook the call warns that the calling cues keep their old values (with the console's reference count; no scan). " +
        "Per line: speed_master n (1-16, a number only; 0 / null clears) links the line to speed master 3.n (SPEEDMASTEROVERRIDE), read back by the master's name (read from the master) and in the cooked values; the master multiplies Speed X, so a line with a master and a Speed X other than 60 is warned about. adaptive_measure / adaptive_width set PLAYBACKADAPTIVEMEASURE / PLAYBACKADAPTIVEWIDTH; a measure switches Adaptive Measure off first (warned when the line had it); a width under Adaptive Width needs adaptive_width: false. Under Adaptive the measure / widths the console derives (a new group, MAtricks or wings) are not compared. " +
        "Per line: transform (none / mirror, PHASERTRANSFORM), invert_style, x / y {wings, blocks, groups} (the line's own columns; null clears) and phase_y, set with the line's settings and read back (Mirror also reads INVERTSTYLE Pan unless invert_style is given, and XInvW / YInvW Yes with the X / Y wings). Mirror applies at the cook: on the mirrored wing the cooked values are hard (100 - x absolute, -x relative) with no step preset; the read-back counts them as the line's own (any member of its group, the attributes of INVERTSTYLE), and requires its step presets on the other wing. Mirror without wings is warned about (it mirrors nothing). Refused with a MAtricks object on the line. " +
        "preview: true runs the checks and returns the plan. Needs bridge 0.52.1.",
      inputSchema: {
        action: z.enum(["create", "set", "add_line", "remove_line"]),
        preset: z.string().describe('Target preset "P.N": create: a free slot in any pool (the pool does not filter recipe lines); set / add_line / remove_line: an existing phaser preset.'),
        line: z.number().optional().describe("set / remove_line: the line number (default 1)."),
        name: z.string().optional().describe("Preset name (otherwise the console names it after the lines)."),
        lines: z.array(z.object(lineShape)).optional().describe("Several lines (1-8), instead of the one-line fields below."),
        selection: lineShape.selection.optional(),
        shape: lineShape.shape,
        steps: lineShape.steps.optional().describe("Exactly 2 steps. create / add_line: each a preset or sources. set: {} keeps a step."),
        matricks: lineShape.matricks,
        speed_bpm: lineShape.speed_bpm,
        phase: lineShape.phase,
        measure: lineShape.measure,
        speed_master: lineShape.speed_master,
        adaptive_measure: lineShape.adaptive_measure,
        adaptive_width: lineShape.adaptive_width,
        transform: lineShape.transform,
        invert_style: lineShape.invert_style,
        x: lineShape.x,
        y: lineShape.y,
        phase_y: lineShape.phase_y,
        exclusive: z.boolean().optional().describe("create: required (true) unless preview: nobody else uses the programmer or the Edit Recipe mode meanwhile. Not used by the edit actions."),
        recook: z
          .union([z.boolean(), z.object({ sequences: z.array(z.number().int()).optional(), mode: z.enum(RECOOK_MODES).optional() }).strict()])
          .optional()
          .describe("set / add_line / remove_line: after a matched edit, re-cook the cue parts that call the preset (true: every sequence; sequences: only these; mode merge_low_priority (default) or merge) and read them back. preview: lists them."),
        preview: z.boolean().optional(),
      },
    },
    async (args) => operation(() => ((args as CreateArgs).action === "create" ? createPhaserRecipe(ctx, args as CreateArgs) : editPhaserRecipe(ctx, args as EditArgs))),
  );
};
