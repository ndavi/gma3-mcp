/**
 * Re-cooking the cues that call an edited phaser preset (gma3_edit_phaser_recipe `recook`).
 *
 * A cue that calls a phaser preset with a standard line holds the preset's values as its own cooked data. Editing
 * the preset is not guaranteed to reach that data (onPC 2.5.1, THK migration benches 2026-11-14/15,
 * docs/phaser-recipes.md §1.5, §3, docs/specificites-gma3.md "Modification d'un preset phaser"):
 *   - a bench saw a new width or trans of a step not show in the cue until it was re-cooked (Off then Goto was not
 *     enough; after the cook the running cue switched at once), and once a new speed;
 *   - other runs saw the cue follow at once: a speed, a new family, a retargeted step and a removed line (21.9005), a
 *     width and a trans in the cue's cooked data and output (21.9075 / Sequence 9031, gma3-mcp, 2026-11-15).
 * The cause of the difference is not known, so the cue parts are re-cooked, and verified, after every change.
 *
 * What is reused:
 *   - finding the callers: gma3_preset_usage's scan (`presetUsage` with a sink): every cue part whose stored values
 *     or recipe lines reference the preset. Not searched: presets that embed it, CueZero and OffCue.
 *   - cooking: gma3_cook_recipes (`cookRecipes`), one cue PART at a time (never the whole cue: a cue-wide
 *     MergeLowPriority cook empties part 0 where another part holds the same attributes, bench 2026-11-15), with its
 *     own inspection, refusal of a merge over uncooked values and coverage read-back.
 *
 * Read back per cue: every cooked value of the part that references the preset matches the preset's value for the
 * same fixture and attribute (steps with their presets, values, curves, trans and width; phase, measure, speed
 * master, and the speed unless the cue line has its own Speed X: SPEEDFROMX not None), no such value is left on a
 * fixture and attribute the preset no longer outputs, OwnNonCookedDataPresent is No, the cue's other parts unchanged.
 */
import { HeldLock } from "../mutations.js";
import { asRead, stepFromError, type OperationResult, type StepResult, type StepStatus } from "../results.js";
import { hasUncertainStep } from "../batch.js";
import type { Validator } from "../validate.js";
import type { ToolContext } from "./context.js";
import type { ObjectRefInfo, PresetRead, PresetRow } from "./presets.js";
import { presetUsage, readCue, sameObject, valueOf, type CueRead, type PresetUsageHit, type PresetUsageSink, type TargetPreset } from "./analysis.js";
import { cookRecipes } from "./recipes.js";

export const RECOOK_MODES = ["merge_low_priority", "merge"] as const;
export type RecookMode = (typeof RECOOK_MODES)[number];
export interface RecookSpec {
  /** Only these sequences are searched (and re-cooked); every sequence otherwise. */
  sequences?: number[];
  mode: RecookMode;
}

/** The usage scan's budget: a re-cook reads every cue in scope, so give `sequences` on a large show. */
const SCAN = { max_cues: 1000, max_seconds: 120 };
const NOT_SEARCHED = "presets that embed this preset (their own cooked data is not re-cooked), CueZero and OffCue";

export function parseRecook(v: Validator, raw: unknown): RecookSpec | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return { mode: "merge_low_priority" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    v.fail("recook must be true or {sequences?, mode?}");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => k !== "sequences" && k !== "mode");
  if (unknown.length) v.fail(`recook: ${unknown.join(", ")} not known (sequences, mode)`);
  const spec: RecookSpec = { mode: "merge_low_priority" };
  if (r.mode !== undefined) {
    if (!(RECOOK_MODES as readonly unknown[]).includes(r.mode)) v.fail(`recook.mode must be ${RECOOK_MODES.join(" or ")}`);
    else spec.mode = r.mode as RecookMode;
  }
  if (r.sequences !== undefined) {
    if (!Array.isArray(r.sequences) || !r.sequences.length || r.sequences.length > 500 || !r.sequences.every((n) => Number.isInteger(n) && n >= 1 && n <= 99999)) v.fail("recook.sequences must list 1-500 sequence numbers");
    else spec.sequences = [...new Set(r.sequences as number[])];
  }
  return spec;
}

export interface RecookedPart {
  part: string;
  outcome: string;
  verification: string;
  /** Cooked values of the part that reference the preset, compared with the preset's. */
  compared: number;
  ownNonCookedDataPresent: boolean | null;
  problems?: string[];
}
export interface SkippedPart {
  part: string;
  reason: string;
}
export interface RecookReport {
  scope: string;
  mode: RecookMode;
  /** The usage scan read everything in scope: otherwise a calling cue may have been missed. */
  complete: boolean;
  reasons?: string[];
  recooked: RecookedPart[];
  skipped: SkippedPart[];
  /** preview: the cue parts a call would re-cook. */
  wouldRecook?: string[];
  notSearched: string;
}

export interface RecookDeps {
  usage: typeof presetUsage;
  cook: typeof cookRecipes;
}
const DEFAULT_DEPS: RecookDeps = { usage: presetUsage, cook: cookRecipes };

const partLabel = (h: { sequence: number; cue: string; part: number }) => `Sequence ${h.sequence} Cue ${h.cue} Part ${h.part}`;
const rowKey = (r: PresetRow) => `${r.fixture}|${r.attribute}`;
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const close = (a: unknown, b: unknown, tol: number) => {
  const x = num(a);
  const y = num(b);
  return x === undefined || y === undefined ? x === y : Math.abs(x - y) <= tol;
};
const sameRef = (a: ObjectRefInfo | null | undefined, b: ObjectRefInfo | null | undefined) =>
  !a || a.valid === false ? !b || b.valid === false : !!b && b.valid !== false && (a.addr !== undefined && b.addr !== undefined ? a.addr === b.addr : a.addrNative === b.addrNative);
const refText = (r: ObjectRefInfo | null | undefined) => (!r || r.valid === false ? "none" : r.pool !== undefined && r.no !== undefined ? `${r.pool}.${r.no}` : (r.addr ?? "?"));
const fmt = (x: unknown) => (typeof x === "number" ? String(+x.toFixed(3)) : x === undefined || x === null ? "none" : String(x));

/** Does the cue row come from the preset (its absolute or relative layer references it)? */
export const fromPreset = (r: PresetRow, preset: TargetPreset) => sameObject(r.absPreset, preset) || sameObject(r.relPreset, preset);

/**
 * The part's cooked values from the preset against the preset's own values, per fixture and attribute.
 * `ignoreSpeed`: the cue line has its own Speed X (which replaces the preset's speed).
 */
export function cookedDiff(cueRows: PresetRow[], presetRows: PresetRow[], preset: TargetPreset, o: { ignoreSpeed?: boolean; label: string }): { compared: number; problems: string[] } {
  const ours = cueRows.filter((r) => fromPreset(r, preset));
  const byKey = new Map(presetRows.map((r) => [rowKey(r), r]));
  const off = new Map<string, { n: number; first: string }>();
  const note = (field: string, first: string) => {
    const e = off.get(field);
    if (e) e.n++;
    else off.set(field, { n: 1, first });
  };
  for (const r of ours) {
    const p = byKey.get(rowKey(r));
    const at = `fixture ${r.fixture} ${r.attribute}`;
    if (!p) {
      note("gone", `${at}: the preset no longer outputs it`);
      continue;
    }
    if (r.cooked !== true) note("uncooked", `${at} is not cooked`);
    const rs = r.steps ?? [];
    const ps = p.steps ?? [];
    if ((r.stepCount ?? rs.length) !== (p.stepCount ?? ps.length)) note("step count", `${at} has ${r.stepCount ?? rs.length} step(s), the preset ${p.stepCount ?? ps.length}`);
    ps.forEach((pst, i) => {
      const cst = rs.find((x) => x.step === pst.step) ?? rs[i];
      if (!cst) return;
      for (const k of ["width", "trans", "accel", "decel", "absolute", "relative"] as const) {
        if (!close(cst[k], pst[k], 0.01)) note(`${k} step ${pst.step}`, `${at} reads ${fmt(cst[k])}, the preset ${fmt(pst[k])}`);
      }
      if (!sameRef(cst.integrated, pst.integrated)) note(`preset step ${pst.step}`, `${at} reads ${refText(cst.integrated)}, the preset ${refText(pst.integrated)}`);
    });
    if (!close(r.phase, p.phase, 0.01)) note("phase", `${at} reads ${fmt(r.phase)}, the preset ${fmt(p.phase)}`);
    if (!close(r.measure, p.measure, 0.01)) note("measure", `${at} reads ${fmt(r.measure)}, the preset ${fmt(p.measure)}`);
    if ((r.speedMaster ?? null) !== (p.speedMaster ?? null)) note("speed master", `${at} reads ${fmt(r.speedMaster)}, the preset ${fmt(p.speedMaster)}`);
    if (!o.ignoreSpeed && !close(r.speed, p.speed, 1e-4)) note("speed", `${at} reads ${fmt(num(r.speed) !== undefined ? num(r.speed)! * 60 : r.speed)} BPM, the preset ${fmt(num(p.speed) !== undefined ? num(p.speed)! * 60 : p.speed)} BPM`);
  }
  const problems = [...off].map(([field, e]) => (field === "gone" ? `${o.label}: ${e.n} cooked value(s) still come from the preset where it no longer outputs (first: ${e.first})` : `${o.label}: ${e.n} cooked value(s) differ from the preset in ${field} (first: ${e.first})`));
  return { compared: ours.length, problems };
}

/** The cue line(s) calling the preset with their own Speed X (SPEEDFROMX not None). */
async function ownSpeedLines(ctx: ToolContext, partRef: string, lines: number[]): Promise<number[]> {
  const res = (await ctx.bridge.request("children", { ref: partRef, fields: ["SPEEDFROMX"], limit: 1000 }, ctx.requestTimeoutMs)) as { items?: Array<{ index?: number; fields?: Record<string, unknown> }> };
  return (res.items ?? []).filter((it) => lines.includes(Number(it.index)) && !/^(none|)$/i.test(String(it.fields?.SPEEDFROMX ?? "None").trim())).map((it) => Number(it.index));
}

/** Every stored value of a part as comparable text, per fixture and attribute. */
const contentOf = (rows: PresetRow[]) => new Map(rows.map((r) => [rowKey(r), JSON.stringify({ c: r.cooked === true, v: valueOf(r) })]));

/**
 * Finds the cue parts that call `ref` (gma3_preset_usage's scan) and re-cooks each one with gma3_cook_recipes,
 * then reads them back against the preset's values. `skipAll`: the reason not to cook (the preset's own edit did not
 * read back as asked); the callers are still listed. `preview`: list only.
 */
export async function recookCallers(
  ctx: ToolContext,
  o: { preset: { pool: number; number: number }; presetRead: PresetRead | null; spec: RecookSpec; skipAll?: string; preview?: boolean },
  deps: RecookDeps = DEFAULT_DEPS,
): Promise<{ steps: StepResult[]; report: RecookReport; problems: string[]; warnings: string[] }> {
  const ref = `Preset ${o.preset.pool}.${o.preset.number}`;
  const steps: StepResult[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const report: RecookReport = { scope: o.spec.sequences ? `Sequence(s) ${o.spec.sequences.join(", ")}` : "every sequence", mode: o.spec.mode, complete: false, recooked: [], skipped: [], notSearched: NOT_SEARCHED };

  // 1. The callers.
  const sink: PresetUsageSink = { hits: [] };
  try {
    const res = await deps.usage(ctx, { preset: `${o.preset.pool}.${o.preset.number}`, executors: false, ...(o.spec.sequences ? { sequences: o.spec.sequences } : {}), ...SCAN }, sink);
    if (res.isError) {
      const text = res.content.map((c) => c.text).join(" ");
      let why = text;
      try {
        why = String((JSON.parse(text) as { error?: unknown }).error ?? text);
      } catch {
        /* plain text */
      }
      steps.push(asRead({ name: "find_callers", status: "failed", op: "gma3_preset_usage", error: `the cues calling ${ref} could not be found: ${why}` }));
      report.reasons = [why];
      return { steps, report, problems, warnings: [`the cues calling ${ref} were not re-cooked: they could not be found (${why})`] };
    }
  } catch (err) {
    const s = stepFromError("find_callers", err, { op: "gma3_preset_usage" });
    steps.push(asRead(s));
    report.reasons = [s.error ?? "the scan failed"];
    return { steps, report, problems, warnings: [`the cues calling ${ref} were not re-cooked: ${s.error}`] };
  }
  report.complete = sink.complete === true;
  if (sink.reasons?.length) report.reasons = sink.reasons;
  steps.push(asRead({ name: "find_callers", status: "succeeded", op: "gma3_preset_usage", detail: { parts: sink.hits.length, complete: report.complete } }));
  if (!report.complete) warnings.push(`the search for the cues calling ${ref} is incomplete (${(sink.reasons ?? []).join("; ") || "unknown reason"}): a calling cue may not have been re-cooked`);

  // 2. What can be cooked: a part with a recipe line calling the preset.
  const toCook: PresetUsageHit[] = [];
  for (const h of sink.hits) {
    if (!h.recipeLines.length) report.skipped.push({ part: partLabel(h), reason: `its values reference ${ref} (${h.via.join(", ")}) but none of its recipe lines calls it: values stored without a recipe, or cooked from another preset that calls ${ref}; a cook of this part would not update them` });
    else if (o.skipAll) report.skipped.push({ part: partLabel(h), reason: o.skipAll });
    else toCook.push(h);
  }
  if (o.preview) report.wouldRecook = toCook.map(partLabel);
  if (o.preview || !toCook.length) return { steps, report, problems, warnings };

  // 3. Cook part by part, read back cue by cue.
  const held: ToolContext = { ...ctx, mutations: new HeldLock() };
  const presetRows = o.presetRead?.rows ?? [];
  const target: TargetPreset = { addr: o.presetRead?.addr, addrNative: o.presetRead?.addrNative };
  if (!target.addr && !target.addrNative) warnings.push(`${ref}'s address was not read: the cue values cannot be matched to it`);
  const cues = new Map<string, PresetUsageHit[]>();
  for (const h of toCook) cues.set(`${h.sequence}|${h.cue}`, [...(cues.get(`${h.sequence}|${h.cue}`) ?? []), h]);
  let halted: string | null = null;
  for (const hits of cues.values()) {
    const { sequence, cue } = hits[0];
    if (halted) {
      for (const h of hits) report.skipped.push({ part: partLabel(h), reason: halted });
      continue;
    }
    const before: CueRead = await readCue(ctx.bridge, sequence, cue, ctx.requestTimeoutMs);
    const done: Array<{ h: PresetUsageHit; r: OperationResult; ownSpeed: number[] }> = [];
    for (const h of hits) {
      const label = partLabel(h);
      if (halted) {
        report.skipped.push({ part: label, reason: halted });
        continue;
      }
      let ownSpeed: number[] = [];
      try {
        ownSpeed = await ownSpeedLines(ctx, label, h.recipeLines);
      } catch (err) {
        warnings.push(`${label}: the cue line's Speed X could not be read (${err instanceof Error ? err.message : String(err)}); its speed is compared with the preset's`);
      }
      const r = await deps.cook(held, { target: { sequence, cue: h.cue, part: h.part }, mode: o.spec.mode, verify: true });
      const status: StepStatus = hasUncertainStep(r) ? "unknown" : r.outcome === "succeeded" ? "succeeded" : "failed";
      steps.push({ name: `recook ${label}`, status, op: "gma3_cook_recipes", ...(typeof r.command === "string" ? { command: r.command } : {}), ...(status === "succeeded" ? {} : { error: r.summary }) });
      warnings.push(...(r.warnings ?? []).map((w) => `recook ${label}: ${w}`));
      if (status === "unknown") halted = `not attempted: the cook of ${label} got no reply, so the console's state is not known`;
      if (status !== "succeeded") {
        problems.push(`${label} was not re-cooked: ${r.summary}`);
        report.recooked.push({ part: label, outcome: r.outcome, verification: r.verification.status, compared: 0, ownNonCookedDataPresent: null, problems: [r.summary] });
        continue;
      }
      done.push({ h, r, ownSpeed });
    }
    if (!done.length) continue;
    const after: CueRead = await readCue(ctx.bridge, sequence, cue, ctx.requestTimeoutMs);
    for (const { h, r, ownSpeed } of done) {
      const label = partLabel(h);
      const mine: string[] = [];
      if (r.verification.status === "mismatched") mine.push(`${label}: the cook's read-back: ${r.verification.detail ?? "mismatched"}`);
      const pb = before.parts.find((p) => p.part === h.part);
      const pa = after.parts.find((p) => p.part === h.part);
      let compared = 0;
      if (after.error || !pa) mine.push(`${label} could not be read after the cook${after.error ? `: ${after.error}` : ""}`);
      else {
        if (pa.unread) mine.push(`${label} was not read completely: ${pa.unread}`);
        const d = cookedDiff(pa.rows, presetRows, target, { ignoreSpeed: ownSpeed.length > 0, label });
        compared = d.compared;
        mine.push(...d.problems);
        if (!compared && presetRows.length && (pb?.rows ?? []).some((x) => fromPreset(x, target) && presetRows.some((p) => rowKey(p) === rowKey(x)))) mine.push(`${label}: no cooked value references ${ref} after the cook`);
        if (pa.ownNonCookedDataPresent === true) {
          if (pb?.ownNonCookedDataPresent === true) warnings.push(`${label} holds values not cooked from its recipes (OwnNonCookedDataPresent Yes) before and after the re-cook: not made by this call`);
          else mine.push(`${label} reads OwnNonCookedDataPresent Yes after the cook (values not cooked from recipes)`);
        }
        if (ownSpeed.length) warnings.push(`${label}: line ${ownSpeed.join(", ")} has its own Speed X, which replaces the preset's speed (not compared)`);
      }
      problems.push(...mine);
      report.recooked.push({ part: label, outcome: r.outcome, verification: r.verification.status, compared, ownNonCookedDataPresent: pa?.ownNonCookedDataPresent ?? null, ...(mine.length ? { problems: mine } : {}) });
    }
    // The cue's other parts: not cooked, so unchanged.
    const cookedParts = new Set(done.map((x) => x.h.part));
    for (const pb of before.parts) {
      if (pb.part === null || cookedParts.has(pb.part)) continue;
      const pa = after.parts.find((p) => p.part === pb.part);
      const a = contentOf(pa?.rows ?? []);
      const b = contentOf(pb.rows);
      const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
      if (changed.length) problems.push(`Sequence ${sequence} Cue ${cue} Part ${pb.part} (not cooked by this call) changed: ${changed.length} value(s) (first: ${changed[0].replace("|", " ")})`);
    }
  }
  steps.push(asRead({ name: "recook_read_back", status: "succeeded", op: "preset.read" }));
  return { steps, report, problems, warnings };
}
