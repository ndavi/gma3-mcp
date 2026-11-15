/**
 * Generators (Random) for recipe lines.
 *
 *   gma3_store_generator   create a Random generator in a free slot (`Store Generator N /NoConfirmation`, empty
 *                          programmer), or edit one: one channel per attribute, its settings, read back
 *
 * A standard recipe line of a preset takes the generator with `Assign Generator N At Preset P.N.L` (gma3_edit_recipe
 * `generator`), in place of a values preset; the line cooks a token value (6500) on every member of its group that has
 * the channel's attribute, and a cue that calls the preset stays 100 % recipe. `readGenerator` gives the recipe tools
 * the attributes a generator line cooks.
 *
 * Console facts this module relies on (onPC 2.5.1.1, show "Rescue", 2026-11-15; THK migration bench 15 Nov 2026):
 *   - Generators live in ShowData.DataPools.Default.GeneratorTypes.Generators (`Generator N`, class Random). Its
 *     children are GeneratorConfigurations (`N.1`) and RandomChannels (`N.2`); a channel is `Generator N.2.k`
 *     (class RandomChannel).
 *   - `Store Generator N /NoConfirmation` (programmer empty) creates it with one channel: Dimmer, Speed 60, Ratio 50,
 *     Attack 100, Decay 100, variances 0. `Store Generator N.2.k /NoConfirmation` adds channel k with the same
 *     defaults. Only k = count + 1 is used (a gap is not verified).
 *   - `Assign Attribute "<Attr>" At Generator N.2.k` sets the channel's attribute (a `set` is refused; an unknown
 *     attribute answers "Illegal object").
 *   - `Set Generator N.2.k Property "<Prop>" "<v>"` sets one setting of one channel: Speed (cycles per minute), Ratio
 *     (% of the time at the high level), Attack, Decay, LowVariance, HighVariance (%), PhaseVariance (degrees),
 *     SpeedMaster. "abc" answers "Illegal value"; Ratio "150" answers OK and stores 100 (out-of-range values are
 *     refused here).
 *   - SpeedMaster is 0-based: "0" links master 3.1, "1" master 3.2; "None" clears. It reads back as the master's name
 *     ("" when cleared). The link takes effect at the next Goto of the cue that plays the line (bench).
 *   - Read with asText false, ATTRIBUTE is the attribute's name and SPEED is in cycles per minute (15); as text,
 *     ATTRIBUTE is a handle number and SPEED is in Hz ("0.250000"). The percent fields read truncated with asText false
 *     (RATIO 19 for 20, 33 for 33.3) and exact as text ("20.00"): both reads are made.
 *   - `Assign Generator N At <line>` replaces the line's values preset, and `Assign Preset` replaces the generator: a
 *     line holds one or the other. `Assign Generator <missing> At <line>` answers OK and changes nothing.
 *   - The line's Speed X has no effect on a generator.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { asRead, buildResult, commandStep, notRequested, requestStep, runSteps, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, finiteNumber, objectName, objectNumber } from "../validate.js";

/** The channel settings this tool writes: field name, console property, range, and how it reads back. */
export const CHANNEL_SETTINGS = [
  { key: "speed", property: "Speed", field: "SPEED", min: 0.001, max: 6000, unit: "cycles per minute" },
  { key: "ratio", property: "Ratio", field: "RATIO", min: 0, max: 100, unit: "%" },
  { key: "attack", property: "Attack", field: "ATTACK", min: 0, max: 100, unit: "%" },
  { key: "decay", property: "Decay", field: "DECAY", min: 0, max: 100, unit: "%" },
  { key: "low_variance", property: "LowVariance", field: "LOWVARIANCE", min: 0, max: 100, unit: "%" },
  { key: "high_variance", property: "HighVariance", field: "HIGHVARIANCE", min: 0, max: 100, unit: "%" },
  { key: "phase_variance", property: "PhaseVariance", field: "PHASEVARIANCE", min: 0, max: 360, unit: "degrees" },
] as const;
type SettingKey = (typeof CHANNEL_SETTINGS)[number]["key"];

/** Every field of a channel the read returns (the ones this tool does not write are reported as read). */
const CHANNEL_FIELDS = ["ATTRIBUTE", "SPEEDMASTER", "SPEED", "RATIO", "ATTACK", "DECAY", "LOWVARIANCE", "HIGHVARIANCE", "PHASEVARIANCE", "LOW", "HIGH", "PHASE", "SPEEDVARIANCE", "RATIOVARIANCE", "VIRTUALDIMMER", "SPEEDONCE", "PHASEONCE", "RANDOMSTART"];
const MAX_CHANNELS = 32;
const MAX_MASTER = 16;
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface GeneratorChannel {
  channel: number;
  /** The attribute's name (read with asText false). */
  attribute?: string;
  /** Cycles per minute. */
  speed?: number;
  ratio?: number;
  attack?: number;
  decay?: number;
  low_variance?: number;
  high_variance?: number;
  phase_variance?: number;
  /** The linked speed master's name, "" for none. */
  speedMaster?: string;
  /** The other fields, as text. */
  other: Record<string, unknown>;
}

export interface GeneratorInfo {
  no: number;
  exists: boolean;
  class?: string;
  name?: string;
  channels?: GeneratorChannel[];
  /** Why the channels are not known completely (undefined: they are). */
  incomplete?: string;
}

const notFound = (err: unknown) => err instanceof BridgeError && /no objects? found|no object at address|path not found/i.test(err.message);
type ChildList = { total?: number; offset?: number; count?: number; items?: Array<{ class?: string; index?: number; name?: string; childCount?: number; fields?: Record<string, unknown> }> };
const complete = (r: ChildList) => typeof r.total !== "number" || (r.offset ?? 0) + (r.count ?? r.items?.length ?? 0) >= r.total;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v.replace(",", ".")) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Read a generator and its channels (two reads: names and speed raw, percent fields as text). Cached per call. */
export async function readGenerator(bridge: Gma3Bridge, no: number, t: number, cache?: Map<number, GeneratorInfo>): Promise<GeneratorInfo> {
  const hit = cache?.get(no);
  if (hit) return hit;
  const info = await readGeneratorUncached(bridge, no, t);
  cache?.set(no, info);
  return info;
}

async function readGeneratorUncached(bridge: Gma3Bridge, no: number, t: number): Promise<GeneratorInfo> {
  let res: ChildList;
  try {
    res = (await bridge.request("objects", { ref: `Generator ${no}`, fields: ["Name"], asText: false, limit: 1 }, t)) as ChildList;
  } catch (err) {
    if (notFound(err)) return { no, exists: false };
    throw err;
  }
  const it = res.items?.[0];
  if (!it) return { no, exists: false };
  const info: GeneratorInfo = { no, exists: true, class: it.class, name: typeof it.fields?.Name === "string" ? it.fields.Name : it.name };
  if (it.class !== "Random") {
    info.incomplete = `Generator ${no} is a ${it.class ?? "?"}: only Random generators are modelled`;
    return info;
  }
  let raw: ChildList;
  let text: ChildList;
  try {
    raw = (await bridge.request("children", { ref: `Generator ${no}.2`, fields: CHANNEL_FIELDS, asText: false, limit: 100 }, t)) as ChildList;
    text = (await bridge.request("children", { ref: `Generator ${no}.2`, fields: CHANNEL_FIELDS, asText: true, limit: 100 }, t)) as ChildList;
  } catch (err) {
    if (!notFound(err)) throw err;
    info.incomplete = `the channels of Generator ${no} (Generator ${no}.2) could not be read`;
    return info;
  }
  if (!complete(raw) || !complete(text)) info.incomplete = `the channels of Generator ${no} were not read completely`;
  const byIndex = new Map((text.items ?? []).map((x) => [x.index, x.fields ?? {}]));
  info.channels = (raw.items ?? [])
    .filter((x) => x.class === "RandomChannel")
    .map((x, i) => {
      const r = x.fields ?? {};
      const tx = byIndex.get(x.index) ?? {};
      const k = typeof x.index === "number" ? x.index : i + 1;
      const c: GeneratorChannel = { channel: k, other: {} };
      if (typeof r.ATTRIBUTE === "string" && r.ATTRIBUTE && !r.ATTRIBUTE.startsWith("#")) c.attribute = r.ATTRIBUTE;
      // SPEED: cycles per minute raw; the text is Hz.
      const sp = num(r.SPEED) ?? (num(tx.SPEED) !== undefined ? num(tx.SPEED)! * 60 : undefined);
      if (sp !== undefined) c.speed = Math.round(sp * 1e4) / 1e4;
      for (const s of CHANNEL_SETTINGS) {
        if (s.key === "speed") continue;
        const v = num(tx[s.field]) ?? num(r[s.field]);
        if (v !== undefined) c[s.key] = v;
      }
      const sm = typeof r.SPEEDMASTER === "string" ? r.SPEEDMASTER : typeof tx.SPEEDMASTER === "string" ? tx.SPEEDMASTER : undefined;
      if (sm !== undefined) c.speedMaster = sm.trim();
      for (const f of ["LOW", "HIGH", "PHASE", "SPEEDVARIANCE", "RATIOVARIANCE", "VIRTUALDIMMER", "SPEEDONCE", "PHASEONCE", "RANDOMSTART"]) if (tx[f] !== undefined) c.other[f] = tx[f];
      return c;
    });
  if (info.channels.some((c) => !c.attribute)) info.incomplete = [info.incomplete, "a channel's attribute could not be read"].filter(Boolean).join("; ");
  return info;
}

/** The attributes a generator line cooks (one per channel), or why they are not known. */
export function generatorAttributes(g: GeneratorInfo): { attributes: string[] } | { why: string } {
  if (!g.exists) return { why: `Generator ${g.no} is not in the show` };
  if (g.incomplete || !g.channels) return { why: g.incomplete ?? `the channels of Generator ${g.no} were not read` };
  return { attributes: [...new Set(g.channels.map((c) => c.attribute!))] };
}

/** The 16 speed masters' names by number (Master 3.n). */
async function masterNames(bridge: Gma3Bridge, t: number): Promise<Map<number, string>> {
  const r = (await bridge.request("children", { ref: "ShowData.Masters.Speed", fields: ["Name"], limit: 32 }, t)) as ChildList;
  const out = new Map<number, string>();
  for (const it of r.items ?? []) if (typeof it.index === "number") out.set(it.index, String(it.fields?.Name ?? it.name ?? ""));
  return out;
}

/** Values in the programmer (a complete scan only; null: not known). */
async function programmerValues(bridge: Gma3Bridge, t: number): Promise<number | null> {
  const r = (await bridge.request("programmer", { scope: "all", limit: 1 }, t)) as { total?: number; coverage?: { complete?: boolean } };
  return r.coverage?.complete === true && typeof r.total === "number" ? r.total : null;
}

// ---------------------------------------------------------------------------
// gma3_store_generator
// ---------------------------------------------------------------------------

interface ChannelSpec {
  channel?: number;
  attribute?: string;
  settings: Partial<Record<SettingKey, number>>;
  /** 1-16 (master 3.n); null clears. */
  speedMaster?: number | null;
}

interface StoreGeneratorArgs {
  generator: unknown;
  action: unknown;
  name?: unknown;
  channels?: unknown;
  preview?: unknown;
}

function parseChannel(v: Validator, raw: unknown, at: string): ChannelSpec | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    v.fail(`${at} must be an object`);
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const known = new Set(["channel", "attribute", "speed_master", ...CHANNEL_SETTINGS.map((s) => s.key)]);
  for (const k of Object.keys(o)) if (!known.has(k)) v.fail(`${at}.${k} is not a channel field (${[...known].join(", ")})`);
  const spec: ChannelSpec = { settings: {} };
  if (o.channel !== undefined) spec.channel = v.check(() => finiteNumber(`${at}.channel`, o.channel, { integer: true, min: 1, max: MAX_CHANNELS }));
  if (o.attribute !== undefined) {
    if (typeof o.attribute !== "string" || !ATTRIBUTE_NAME.test(o.attribute)) v.fail(`${at}.attribute must be an attribute name such as "Dimmer" or "Pan"`);
    else spec.attribute = o.attribute;
  }
  for (const s of CHANNEL_SETTINGS) {
    if (o[s.key] === undefined) continue;
    const n = v.check(() => finiteNumber(`${at}.${s.key}`, o[s.key], { min: s.min, max: s.max }));
    if (n !== undefined) spec.settings[s.key] = n;
  }
  if (o.speed_master !== undefined) {
    const m = o.speed_master;
    if (m === null || m === 0) spec.speedMaster = null;
    else if (typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_MASTER) spec.speedMaster = m;
    else v.fail(`${at}.speed_master must be a speed master number 1-${MAX_MASTER} (master 3.n; 0 or null clears the link), got ${JSON.stringify(m)}`);
  }
  return spec;
}

/** A channel's commands: the attribute first, then one Set per setting (the console takes one property per command). */
function channelCommands(ref: string, c: ChannelSpec): Array<{ name: string; command: string }> {
  const out: Array<{ name: string; command: string }> = [];
  if (c.attribute) out.push({ name: "assign_attribute", command: `Assign Attribute "${c.attribute}" At ${ref}` });
  for (const s of CHANNEL_SETTINGS) {
    const val = c.settings[s.key];
    if (val !== undefined) out.push({ name: `set_${s.key}`, command: `Set ${ref} Property "${s.property}" "${val}"` });
  }
  // SpeedMaster is 0-based (master 3.1 is "0"); "None" clears.
  if (c.speedMaster !== undefined) out.push({ name: "set_speed_master", command: `Set ${ref} Property "SpeedMaster" "${c.speedMaster === null ? "None" : c.speedMaster - 1}"` });
  return out;
}

/** The differences between what a channel was asked to be and what it reads. */
export function channelDiff(c: ChannelSpec & { channel: number }, got: GeneratorChannel | undefined, names: Map<number, string>): string[] {
  const at = `channel ${c.channel}`;
  if (!got) return [`${at} is missing`];
  const out: string[] = [];
  if (c.attribute && (got.attribute ?? "").toLowerCase() !== c.attribute.toLowerCase()) out.push(`${at} attribute reads ${JSON.stringify(got.attribute ?? null)}, ${c.attribute} expected`);
  for (const s of CHANNEL_SETTINGS) {
    const want = c.settings[s.key];
    if (want === undefined) continue;
    const have = got[s.key];
    if (have === undefined || Math.abs(have - want) > 0.01) out.push(`${at} ${s.key} reads ${have ?? "nothing"}, ${want} expected`);
  }
  if (c.speedMaster !== undefined) {
    const want = c.speedMaster === null ? "" : (names.get(c.speedMaster) ?? "");
    if ((got.speedMaster ?? "").toLowerCase() !== want.toLowerCase()) out.push(`${at} speed master reads ${got.speedMaster ? JSON.stringify(got.speedMaster) : got.speedMaster === "" ? "none" : "unreadable"}, ${want ? JSON.stringify(want) : "none"} expected`);
  }
  return out;
}

const sameChannel = (a: GeneratorChannel, b: GeneratorChannel) => JSON.stringify({ ...a, channel: 0 }) === JSON.stringify({ ...b, channel: 0 });

export async function storeGenerator(ctx: ToolContext, raw: StoreGeneratorArgs): Promise<OperationResult> {
  const op = "store_generator";
  const v = new Validator();
  const no = v.check(() => objectNumber("generator", raw.generator, { max: 9999 }));
  const action = raw.action;
  if (action !== "create" && action !== "edit") v.fail("action must be create (a free slot) or edit (an existing generator)");
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  if (raw.preview !== undefined && typeof raw.preview !== "boolean") v.fail("preview must be true or false");
  const specs: ChannelSpec[] = [];
  if (raw.channels !== undefined && !Array.isArray(raw.channels)) v.fail("channels must be a list");
  else (raw.channels as unknown[] | undefined ?? []).forEach((c, i) => {
    const s = parseChannel(v, c, `channels[${i}]`);
    if (s) specs.push(s);
  });
  if (specs.length > MAX_CHANNELS) v.fail(`at most ${MAX_CHANNELS} channels`);
  if (action === "create") {
    if (!specs.length) v.fail("create needs channels: one per attribute, each with its attribute");
    specs.forEach((s, i) => {
      if (s.channel !== undefined && s.channel !== i + 1) v.fail(`channels[${i}].channel is ${s.channel}: on create the channels are 1, 2, ... in list order (omit channel)`);
      s.channel = i + 1;
      if (!s.attribute) v.fail(`channels[${i}].attribute is required on create (every channel gets its attribute; the console's default is Dimmer)`);
    });
  }
  if (action === "edit") {
    if (!specs.length && name === undefined) v.fail("edit needs channels or name");
    specs.forEach((s, i) => {
      if (s.channel === undefined) v.fail(`channels[${i}].channel is required on edit`);
      else if (!s.attribute && !Object.keys(s.settings).length && s.speedMaster === undefined) v.fail(`channels[${i}] changes nothing (give attribute, a setting or speed_master)`);
    });
    const nums = specs.map((s) => s.channel).filter((x): x is number => x !== undefined);
    const dup = nums.filter((x, i) => nums.indexOf(x) !== i);
    if (dup.length) v.fail(`channel ${dup[0]} is listed twice`);
  }
  const target: Record<string, unknown> = { generator: raw.generator, action };
  if (!v.ok || no === undefined) return validationFailure(op, target, v.errors);
  const ref = `Generator ${no}`;
  target.ref = ref;
  const bridge = ctx.bridge;
  const tm = ctx.requestTimeoutMs;
  const masters = [...new Set(specs.flatMap((s) => (typeof s.speedMaster === "number" ? [s.speedMaster] : [])))];

  const body = async (): Promise<OperationResult> => {
    let before: GeneratorInfo = { no, exists: false };
    let names = new Map<number, string>();
    const warnings: string[] = [];
    // Commands, built once the existing channels are known (edit appends after the last one).
    const plan: Array<{ name: string; command: string; channel?: number }> = [];
    const stores = () => plan.some((p) => p.command.startsWith("Store "));
    const inspect = await runSteps([
      {
        name: "read_generator",
        run: async () => {
          try {
            before = await readGenerator(bridge, no, tm);
          } catch (err) {
            return asRead(stepFromError("read_generator", err, { op: "objects" }));
          }
          if (action === "create" && before.exists) return asRead({ name: "read_generator", status: "failed", op: "objects", error: `${ref} exists (${before.name ?? "unnamed"}); create only uses a free slot (action edit changes an existing generator)` });
          if (action === "edit") {
            if (!before.exists) return asRead({ name: "read_generator", status: "failed", op: "objects", error: `${ref} is not in the show (action create makes it)` });
            if (before.incomplete || !before.channels) return asRead({ name: "read_generator", status: "failed", op: "children", error: before.incomplete ?? `the channels of ${ref} could not be read` });
            const count = before.channels.length;
            const added = specs.filter((s) => s.channel! > count).map((s) => s.channel!).sort((a, b) => a - b);
            const gap = added.find((k, i) => k !== count + 1 + i);
            if (gap !== undefined) return asRead({ name: "read_generator", status: "failed", op: "children", error: `${ref} has ${count} channel(s): a new channel is ${count + 1}, then ${count + 2}, ... (channel ${gap} would leave a gap)` });
            const bare = specs.find((s) => s.channel! > count && !s.attribute);
            if (bare) return asRead({ name: "read_generator", status: "failed", op: "children", error: `channel ${bare.channel} is new: it needs its attribute` });
          }
          return asRead({ name: "read_generator", status: "succeeded", op: "objects", detail: before.exists ? { name: before.name, channels: before.channels?.length } : { free: true } });
        },
      },
      ...(masters.length
        ? [{
            name: "check_speed_masters",
            run: async (): Promise<StepResult> => {
              try {
                names = await masterNames(bridge, tm);
              } catch (err) {
                return asRead(stepFromError("check_speed_masters", err, { op: "children" }));
              }
              const missing = masters.filter((m) => !names.has(m));
              if (missing.length) return asRead({ name: "check_speed_masters", status: "failed", op: "children", error: `speed master(s) ${missing.map((m) => `3.${m}`).join(", ")} not in the show` });
              for (const m of masters) {
                const n = (names.get(m) ?? "").trim();
                const same = [...names].filter(([k, x]) => k !== m && x.trim().toLowerCase() === n.toLowerCase()).map(([k]) => `3.${k}`);
                if (!n) warnings.push(`speed master 3.${m} has no name: the channel reads its link by name, so it cannot be read back`);
                else if (same.length) warnings.push(`speed master 3.${m} is named ${JSON.stringify(n)} like ${same.join(", ")}: the read-back cannot tell them apart`);
              }
              return asRead({ name: "check_speed_masters", status: "succeeded", op: "children", detail: Object.fromEntries(masters.map((m) => [`3.${m}`, names.get(m)])) });
            },
          }]
        : []),
    ]);
    const count = before.channels?.length ?? 0;
    if (inspect.outcome === "succeeded") {
      if (action === "create") plan.push({ name: "store_generator", command: `Store ${ref} /NoConfirmation` });
      for (const s of [...specs].sort((a, b) => a.channel! - b.channel!)) {
        const cref = `${ref}.2.${s.channel}`;
        const isNew = action === "create" ? s.channel! > 1 : s.channel! > count;
        if (isNew) plan.push({ name: `channel_${s.channel}_store`, command: `Store ${cref} /NoConfirmation`, channel: s.channel });
        for (const c of channelCommands(cref, s)) plan.push({ name: `channel_${s.channel}_${c.name}`, command: c.command, channel: s.channel });
      }
    }
    // A Store with values in the programmer would take them in: refuse unless it is known to be empty.
    if (inspect.outcome === "succeeded" && stores()) {
      const step = await (async (): Promise<StepResult> => {
        try {
          const n = await programmerValues(bridge, tm);
          if (n === null) return asRead({ name: "check_programmer", status: "failed", op: "programmer", error: "the programmer could not be read completely, so it is not known to be empty; nothing was sent" });
          if (n > 0) return asRead({ name: "check_programmer", status: "failed", op: "programmer", error: `the programmer holds ${n} value(s): Store Generator needs an empty programmer. Store or clear your own values first (this tool never clears the programmer)` });
          return asRead({ name: "check_programmer", status: "succeeded", op: "programmer" });
        } catch (err) {
          return asRead(stepFromError("check_programmer", err, { op: "programmer" }));
        }
      })();
      inspect.steps.push(step);
      if (step.status !== "succeeded") inspect.outcome = "failed";
    }
    const extra: Record<string, unknown> = { intended: { commands: [...plan.map((p) => p.command), ...(name !== undefined ? [`set ${ref} Name=${JSON.stringify(name)}`] : [])] }, ...(before.exists ? { before: { name: before.name, channels: before.channels } } : {}) };
    if (inspect.outcome !== "succeeded") return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, extra });
    if (raw.preview === true) return buildResult({ operation: op, target, steps: inspect.steps, summary: "Preview only; nothing was sent.", extra: { ...extra, preview: true } });

    const main = await runSteps([
      ...plan.map((p) => ({ name: p.name, run: () => commandStep(bridge, p.name, p.command, tm) })),
      ...(name !== undefined
        ? [{
            name: "set_name",
            run: () =>
              requestStep(bridge, "set_name", "set", { ref, property: "Name", value: name }, (res) => {
                const got = (res as { value?: unknown } | null)?.value;
                return String(got ?? "").trim() === name ? { name: "set_name", status: "succeeded", op: "set" } : { name: "set_name", status: "failed", op: "set", detail: { readBack: got }, error: `Name reads ${JSON.stringify(got ?? null)} after the write` };
              }, tm),
          }]
        : []),
    ]);
    const steps: StepResult[] = [...inspect.steps, ...main.steps];
    let verification: Verification = notRequested();
    let after: GeneratorInfo | undefined;
    const sent = main.steps.some((s) => s.status !== "skipped");
    if (sent) {
      try {
        after = await readGenerator(bridge, no, tm);
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "children" }));
        const problems: string[] = [];
        if (!after.exists) problems.push(`${ref} is not in the show`);
        else if (after.incomplete || !after.channels) problems.push(after.incomplete ?? "its channels could not be read");
        else {
          const want = action === "create" ? specs.length : Math.max(count, ...specs.map((s) => s.channel!));
          if (after.channels.length !== want) problems.push(`${after.channels.length} channel(s), ${want} expected`);
          for (const s of specs) problems.push(...channelDiff(s as ChannelSpec & { channel: number }, after.channels.find((c) => c.channel === s.channel), names));
          // Edit: the channels not asked for are unchanged.
          for (const b of before.channels ?? []) {
            if (specs.some((s) => s.channel === b.channel)) continue;
            const a = after.channels.find((c) => c.channel === b.channel);
            if (!a || !sameChannel(a, b)) problems.push(`channel ${b.channel} changed (it was not part of the edit)`);
          }
        }
        if (name !== undefined && after.name !== name) problems.push(`the name reads ${JSON.stringify(after.name ?? null)}`);
        verification = problems.length
          ? { status: "mismatched", checked: `${ref}: channel count, attribute and settings of each channel${name !== undefined ? ", name" : ""}`, detail: problems.join("; ") }
          : { status: "matched", checked: `${ref}: ${after.channels!.length} channel(s); attribute and every setting written read back${action === "edit" ? "; the other channels unchanged" : ""}${name !== undefined ? "; the name" : ""}` };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "children" })));
      }
    }
    if (main.outcome !== "succeeded" && action === "create" && steps.some((s) => s.name === "store_generator" && s.status === "succeeded")) warnings.push(`${ref} was created and is kept (nothing is undone)`);
    if (specs.some((s) => typeof s.speedMaster === "number")) warnings.push("a channel's speed master link takes effect at the next Goto of the cue that plays it; the master multiplies the channel's speed");
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, ...(after ? { generator: { no: after.no, name: after.name, class: after.class, channels: after.channels } } : {}) } });
  };
  return raw.preview === true ? body() : ctx.mutations.run(body);
}

const channelShape = z.object({
  channel: z.number().optional().describe("Channel number (edit: required; a new channel is count + 1). create: omit (list order)."),
  attribute: z.string().optional().describe('Attribute name ("Dimmer", "Pan"); required on create and for a new channel.'),
  speed: z.number().optional().describe("Cycles per minute (15 = one cycle every 4 s)."),
  ratio: z.number().optional().describe("% of the time at the high level (about the ma2 Width)."),
  attack: z.number().optional().describe("%."),
  decay: z.number().optional().describe("%."),
  low_variance: z.number().optional().describe("%."),
  high_variance: z.number().optional().describe("%."),
  phase_variance: z.number().optional().describe("Degrees (360 spreads the fixtures)."),
  speed_master: z.number().nullable().optional().describe("Speed master 1-16 (master 3.n); 0 or null clears."),
}).strict();

export const registerGeneratorTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_store_generator",
    {
      title: "Create or edit a Random generator",
      description:
        "A Random generator (Generator pool) for a preset recipe line (gma3_edit_recipe `generator`). action create: a free slot, `Store Generator N /NoConfirmation`; refused unless the programmer is known to be empty (never cleared here). Each further channel is `Store Generator N.2.k /NoConfirmation`. action edit: an existing generator; channels by number, a new one is count + 1. " +
        "Per channel: `Assign Attribute \"<Attr>\" At Generator N.2.k`, then one `Set Generator N.2.k Property \"<P>\" \"<v>\"` per setting: speed (cycles per minute), ratio, attack, decay, low_variance, high_variance (%), phase_variance (degrees), speed_master 1-16 (master 3.n, sent 0-based; 0 / null clears). Values out of range are refused (the console clamps them silently). " +
        "Read back: channel count, each channel's attribute and settings, the speed master by name, the other channels unchanged (edit), the name. The line's Speed X has no effect on a generator; a master link takes effect at the next Goto. Nothing is undone after a failure. preview: true returns the plan.",
      inputSchema: {
        generator: z.number().describe("Generator pool number."),
        action: z.enum(["create", "edit"]),
        name: z.string().optional(),
        channels: z.array(channelShape).optional().describe("create: one per attribute, in order. edit: the channels to change or add."),
        preview: z.boolean().optional(),
      },
    },
    async (args) => operation(() => storeGenerator(ctx, args as StoreGeneratorArgs)),
  );
};
