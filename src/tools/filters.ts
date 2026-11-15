/**
 * Filters for recipe lines.
 *
 *   gma3_store_filter   create a filter in a free slot from a preset (`Assign Preset P.N At Filter F`): the filter passes
 *                       the preset's attributes; APPLYTOFIXTURES No (default) so it does not also limit the fixtures
 *
 * A recipe line takes the filter with `Assign Filter F At <line>` (gma3_edit_recipe, gma3_store_recipe_cues), and its
 * cook then outputs only the filter's attributes. `readFilter` gives the recipe tools what they need to predict that.
 *
 * Console facts this module relies on (onPC 2.5.1.1, show "Rescue", 2026-11-15; THK migration bench 15 Nov 2026):
 *   - A filter is `Filter F` > FilterRuleCollect > Ruleset (FilterRuleAndCollect) > its rules. `Assign Preset P.N At
 *     Filter F` on an empty slot creates it with one FilterRuleUsedInObject rule (`Filter F.1.1.1`, TYPE "Used In
 *     Object", OBJECT the preset) whose APPLYTOFIXTURES is Yes: it would also limit the line to the preset's
 *     fixtures. `set APPLYTOFIXTURES No` on the rule (reply "No") leaves only the attributes. A filter made in the UI
 *     from attributes has a FilterRuleAttributes rule instead (filters 9001, 9002).
 *   - The filter's own ATTRIBUTES property is the attribute mask the rules give (a bit per attribute definition, 647
 *     on Rescue); read with asText false it is a list of the Attribute handles ({obj, name}). Used In Object filters
 *     have it too (9003: Tilt, 9004: Pan).
 *   - The filter keeps layer flags ABSOLUTE, RELATIVE, PHASER, TIMING (all Yes after a create).
 *   - `Assign Filter <missing> At <line>` answers OK and changes nothing: the tools check that the filter exists and
 *     read the line back.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { presetId, type PresetRead } from "./presets.js";
import { asRead, buildResult, commandStep, notRequested, requestStep, runSteps, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, objectName, objectNumber } from "../validate.js";

export interface FilterInfo {
  no: number;
  exists: boolean;
  name?: string;
  /** The attributes the filter passes (its ATTRIBUTES mask), when it could be read. */
  attributes?: string[];
  /** The rules, as read: class, Used In Object target, APPLYTOFIXTURES, INVERT. */
  rules?: Array<{ class: string; object?: string; applyToFixtures?: boolean | null; invert?: boolean | null }>;
  layers?: Record<string, boolean | null>;
  /** Why a line with this filter cannot be predicted from its attribute list alone (undefined: it can). */
  notPredictable?: string;
}

const LAYERS = ["ABSOLUTE", "RELATIVE", "PHASER", "TIMING"] as const;
const FILTER_FIELDS = ["Name", "ATTRIBUTES", ...LAYERS, "HASDYNAMICFILTERRULES", "HASANYMATRICKSDATA", "HASACTIVEATTRIBUTEFILTER"];

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : typeof v === "string" ? (/^(yes|true|on)$/i.test(v.trim()) ? true : /^(no|false|off|)$/i.test(v.trim()) ? false : null) : null);
const notFound = (err: unknown) => err instanceof BridgeError && /no objects? found|no object at address|path not found/i.test(err.message);
const complete = (r: { total?: number; offset?: number; count?: number; items?: unknown[] }) => typeof r.total !== "number" || (r.offset ?? 0) + (r.count ?? r.items?.length ?? 0) >= r.total;

/** The attribute names of an ATTRIBUTES property read with asText false (a list of {obj, name}); null when it is not one. */
export function filterAttributes(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const a of v) {
    const name = a && typeof a === "object" ? ((a as { name?: unknown }).name ?? (a as { obj?: { name?: unknown } }).obj?.name) : undefined;
    if (typeof name !== "string" || !name) return null;
    out.push(name);
  }
  return out;
}

/**
 * Read a filter: its attributes, rules and layer flags, and whether a line's cook can be predicted from the
 * attributes alone. Only the shape verified on the console is predictable: an attribute mask, no dynamic rules or
 * MAtricks data, every layer on, and rules that are attribute rules or Used In Object rules with APPLYTOFIXTURES No,
 * none inverted. Cached per call.
 */
export async function readFilter(bridge: Gma3Bridge, no: number, t: number, cache?: Map<number, FilterInfo>): Promise<FilterInfo> {
  const hit = cache?.get(no);
  if (hit) return hit;
  const info = await readFilterUncached(bridge, no, t);
  cache?.set(no, info);
  return info;
}

async function readFilterUncached(bridge: Gma3Bridge, no: number, t: number): Promise<FilterInfo> {
  let res: { items?: Array<{ class?: string; index?: number; name?: string; childCount?: number; fields?: Record<string, unknown> }> };
  try {
    res = (await bridge.request("objects", { ref: `Filter ${no}`, fields: FILTER_FIELDS, asText: false, limit: 1 }, t)) as typeof res;
  } catch (err) {
    if (notFound(err)) return { no, exists: false };
    throw err;
  }
  const it = res.items?.[0];
  if (!it || (it.class && it.class !== "Filter")) return { no, exists: false };
  const f = it.fields ?? {};
  const info: FilterInfo = { no, exists: true, name: typeof f.Name === "string" ? f.Name : it.name };
  const attrs = filterAttributes(f.ATTRIBUTES);
  if (attrs) info.attributes = attrs;
  info.layers = Object.fromEntries(LAYERS.map((l) => [l.toLowerCase(), bool(f[l])]));
  const why: string[] = [];
  if (!attrs) why.push("its attributes could not be read");
  else if (!attrs.length) why.push("it has no attribute mask");
  if (bool(f.HASACTIVEATTRIBUTEFILTER) === false) why.push("it has no active attribute filter");
  if (bool(f.HASDYNAMICFILTERRULES) !== false) why.push("it has dynamic rules (or they could not be read)");
  if (bool(f.HASANYMATRICKSDATA) !== false) why.push("it carries MAtricks data (or it could not be read)");
  const off = LAYERS.filter((l) => bool(f[l]) !== true);
  if (off.length) why.push(`its layer flag(s) ${off.join(", ")} are not Yes (layers are not modelled)`);
  if (it.childCount !== undefined && it.childCount !== 1) why.push(`it has ${it.childCount} rule collections`);
  try {
    const rules = (await bridge.request("children", { ref: `Filter ${no}.1.1`, fields: ["APPLYTOFIXTURES", "INVERT", "OBJECT"], asText: false, limit: 100 }, t)) as { total?: number; offset?: number; count?: number; items?: Array<{ class?: string; childCount?: number; fields?: Record<string, unknown> }> };
    if (!complete(rules)) why.push("its rules were not read completely");
    info.rules = (rules.items ?? []).map((r) => {
      const obj = r.fields?.OBJECT;
      const o = obj && typeof obj === "object" ? (obj as { name?: string; addr?: string }) : null;
      return { class: String(r.class ?? "?"), ...(o ? { object: o.name ?? o.addr } : {}), applyToFixtures: bool(r.fields?.APPLYTOFIXTURES), invert: bool(r.fields?.INVERT ?? "") };
    });
    if (!info.rules.length) why.push("it has no rules");
    for (const r of info.rules) {
      if (r.class !== "FilterRuleAttributes" && r.class !== "FilterRuleUsedInObject") why.push(`a ${r.class} rule is not modelled`);
      else if (r.invert !== false) why.push(`a ${r.class} rule is inverted (or its INVERT could not be read)`);
      else if (r.class === "FilterRuleUsedInObject" && r.applyToFixtures !== false) why.push(`its Used In Object rule (${r.object ?? "?"}) has APPLYTOFIXTURES ${r.applyToFixtures === true ? "Yes: it also limits the fixtures" : "unread"}`);
    }
  } catch (err) {
    if (!notFound(err)) throw err;
    why.push("its rules could not be read");
  }
  if (why.length) info.notPredictable = why.join("; ");
  return info;
}

// ---------------------------------------------------------------------------
// gma3_store_filter
// ---------------------------------------------------------------------------

interface StoreFilterArgs {
  filter: unknown;
  from_preset: unknown;
  name?: unknown;
  apply_to_fixtures?: unknown;
  preview?: unknown;
}

export async function storeFilter(ctx: ToolContext, raw: StoreFilterArgs): Promise<OperationResult> {
  const op = "store_filter";
  const v = new Validator();
  const no = v.check(() => objectNumber("filter", raw.filter, { max: 9999 }));
  // A string only: as numbers 2.90 and 2.9 are the same, as presets they are not.
  const preset = v.check(() => presetId("from_preset", raw.from_preset));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  if (raw.apply_to_fixtures !== undefined && typeof raw.apply_to_fixtures !== "boolean") v.fail("apply_to_fixtures must be true or false");
  if (raw.preview !== undefined && typeof raw.preview !== "boolean") v.fail("preview must be true or false");
  const target: Record<string, unknown> = { filter: raw.filter, from_preset: raw.from_preset };
  if (!v.ok || no === undefined || !preset) return validationFailure(op, target, v.errors);
  const ref = `Filter ${no}`;
  const presetRef = `Preset ${preset.pool}.${preset.number}`;
  target.ref = ref;
  const applyToFixtures = raw.apply_to_fixtures === true;
  const bridge = ctx.bridge;
  const tm = ctx.requestTimeoutMs;
  const commands = [`Assign ${presetRef} At ${ref}`, `set ${ref}.1.1.1 APPLYTOFIXTURES=${applyToFixtures ? "Yes" : "No"}`, ...(name !== undefined ? [`set ${ref} Name=${JSON.stringify(name)}`] : [])];

  const body = async (): Promise<OperationResult> => {
    let presetAttrs: string[] = [];
    const inspect = await runSteps([
      {
        name: "check_slot",
        run: async () => {
          try {
            const f = await readFilter(bridge, no, tm);
            if (f.exists) return asRead({ name: "check_slot", status: "failed", op: "objects", error: `${ref} exists (${f.name ?? "unnamed"}); this tool only creates a filter in a free slot (an Assign onto an existing filter is not modelled)` });
            return asRead({ name: "check_slot", status: "succeeded", op: "objects" });
          } catch (err) {
            return asRead(stepFromError("check_slot", err, { op: "objects" }));
          }
        },
      },
      {
        name: "check_preset",
        run: async () => {
          let p: PresetRead | null;
          try {
            p = (await bridge.request("preset.read", { ref: presetRef }, tm)) as PresetRead;
          } catch (err) {
            if (notFound(err)) return asRead({ name: "check_preset", status: "failed", op: "preset.read", error: `${presetRef} is not in the show` });
            return asRead(stepFromError("check_preset", err, { op: "preset.read" }));
          }
          presetAttrs = [...new Set((p?.rows ?? []).map((r) => r.attribute))].sort();
          if (!presetAttrs.length) return asRead({ name: "check_preset", status: "failed", op: "preset.read", error: `${presetRef} holds no values: the filter would pass nothing` });
          return asRead({ name: "check_preset", status: "succeeded", op: "preset.read", detail: { attributes: presetAttrs, ...(p?.truncated ? { truncated: true } : {}) } });
        },
      },
    ]);
    const extra: Record<string, unknown> = { intended: { commands }, presetAttributes: presetAttrs };
    if (inspect.outcome !== "succeeded") return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, extra });
    if (raw.preview === true) return buildResult({ operation: op, target, steps: inspect.steps, summary: "Preview only; nothing was sent.", extra: { ...extra, preview: true } });

    const setStep = (step: string, sref: string, property: string, value: string, ok: (got: unknown) => boolean) => () =>
      requestStep(bridge, step, "set", { ref: sref, property, value }, (res) => {
        const got = (res as { value?: unknown } | null)?.value;
        return ok(got) ? { name: step, status: "succeeded", op: "set" } : { name: step, status: "failed", op: "set", detail: { readBack: got }, error: `${property} reads ${JSON.stringify(got ?? null)} after the write` };
      }, tm);
    const main = await runSteps([
      { name: "assign_preset", run: () => commandStep(bridge, "assign_preset", `Assign ${presetRef} At ${ref}`, tm) },
      {
        name: "check_rule",
        run: async () => {
          try {
            const f = await readFilter(bridge, no, tm);
            if (!f.exists) return asRead({ name: "check_rule", status: "failed", op: "children", error: `${ref} was not created` });
            const r = f.rules ?? [];
            if (r.length !== 1 || r[0].class !== "FilterRuleUsedInObject") return asRead({ name: "check_rule", status: "failed", op: "children", error: `${ref} has ${r.map((x) => x.class).join(", ") || "no rules"}, not one Used In Object rule` });
            return asRead({ name: "check_rule", status: "succeeded", op: "children", detail: { object: r[0].object, applyToFixtures: r[0].applyToFixtures } });
          } catch (err) {
            return asRead(stepFromError("check_rule", err, { op: "children" }));
          }
        },
      },
      { name: "set_apply_to_fixtures", run: setStep("set_apply_to_fixtures", `${ref}.1.1.1`, "APPLYTOFIXTURES", applyToFixtures ? "Yes" : "No", (got) => bool(got) === applyToFixtures) },
      ...(name !== undefined ? [{ name: "set_name", run: setStep("set_name", ref, "Name", name, (got) => String(got ?? "").trim() === name) }] : []),
    ]);
    const steps: StepResult[] = [...inspect.steps, ...main.steps];
    let verification: Verification = notRequested();
    let filter: FilterInfo | undefined;
    const warnings: string[] = [];
    if (steps.some((s) => s.name === "assign_preset" && s.status === "succeeded")) {
      try {
        filter = await readFilter(bridge, no, tm);
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "objects" }));
        const problems: string[] = [];
        if (!filter.exists) problems.push(`${ref} is not in the show`);
        const rule = filter.rules?.[0];
        if (filter.rules?.length !== 1 || rule?.class !== "FilterRuleUsedInObject") problems.push(`the rules read ${JSON.stringify(filter.rules ?? null)}`);
        else {
          if (rule.applyToFixtures !== applyToFixtures) problems.push(`APPLYTOFIXTURES reads ${rule.applyToFixtures}`);
          if (rule.invert !== false) problems.push(`INVERT reads ${rule.invert}`);
        }
        if (name !== undefined && filter.name !== name) problems.push(`the name reads ${JSON.stringify(filter.name ?? null)}`);
        const got = new Set(filter.attributes ?? []);
        const missing = presetAttrs.filter((a) => !got.has(a));
        if (!filter.attributes) problems.push("the filter's attributes could not be read");
        else if (missing.length) problems.push(`the filter does not pass ${missing.join(", ")} (in ${presetRef})`);
        const extraAttrs = (filter.attributes ?? []).filter((a) => !presetAttrs.includes(a));
        if (extraAttrs.length) warnings.push(`the filter also passes ${extraAttrs.join(", ")}, which ${presetRef} does not hold`);
        if (applyToFixtures) warnings.push("APPLYTOFIXTURES Yes: the filter also limits a line to the fixtures of the preset; the recipe tools do not predict such a line");
        verification = problems.length ? { status: "mismatched", checked: `${ref}: its rule, APPLYTOFIXTURES, name and attributes`, detail: problems.join("; ") } : { status: "matched", checked: `${ref}: one Used In Object rule on ${presetRef}, APPLYTOFIXTURES ${applyToFixtures ? "Yes" : "No"}, ${name !== undefined ? "the name, " : ""}the attributes of the preset` };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "objects" })));
      }
    }
    if (main.outcome !== "succeeded" && steps.some((s) => s.name === "assign_preset" && s.status === "succeeded")) warnings.push(`${ref} was created and is kept (nothing is undone)`);
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, ...(filter ? { filter: { no: filter.no, name: filter.name, attributes: filter.attributes, rules: filter.rules, layers: filter.layers, ...(filter.notPredictable ? { notPredictable: filter.notPredictable } : {}) } } : {}) } });
  };
  return raw.preview === true ? body() : ctx.mutations.run(body);
}

export const registerFilterTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_store_filter",
    {
      title: "Create a filter from a preset",
      description:
        "Create a filter in a free slot that passes the attributes of a preset, for a recipe line (gma3_edit_recipe / gma3_store_recipe_cues `filter`): `Assign Preset P.N At Filter F`, then APPLYTOFIXTURES No on its Used In Object rule (default; apply_to_fixtures: true keeps Yes, which also limits a line to the preset's fixtures), then the name. " +
        "Checked first: the slot is free (an existing filter is refused) and the preset holds values. Read back: one Used In Object rule, APPLYTOFIXTURES, the name, and the filter's attributes (every attribute of the preset passes). Nothing is undone after a failure. preview: true returns the plan.",
      inputSchema: {
        filter: z.number().describe("Free Filter pool slot."),
        from_preset: z.string().describe('Preset whose attributes the filter passes, as the plain string "P.N" ("2.9041").'),
        name: z.string().optional(),
        apply_to_fixtures: z.boolean().optional().describe("Default false (APPLYTOFIXTURES No: attributes only)."),
        preview: z.boolean().optional(),
      },
    },
    async (args) => operation(() => storeFilter(ctx, args as StoreFilterArgs)),
  );
};
