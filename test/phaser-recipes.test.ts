import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.js";
import { BridgeReplyError } from "./helpers/fake-bridge.js";
import { registerPhaserRecipeTools, editPhaserRecipe, numberMatches, parseSpeedMaster, yesNoOf } from "../src/tools/phaserrecipes.js";
import { cookedDiff, parseRecook, type RecookDeps } from "../src/tools/phaserrecook.js";
import { presetUsage } from "../src/tools/analysis.js";
import { Validator } from "../src/validate.js";

/**
 * gma3_edit_phaser_recipe against a fake console that models the Edit Recipe facts of onPC 2.5.1 (THK migration
 * docs/phaser-recipes.md §1.5, §1.7): At Shape creates the PhaserRecipe line in Part Zero only in the mode, the store
 * moves it into the preset, ClearAll empties the programmer, a pending target makes EditRecipe open "Update last
 * object?" (the bridge ops are covered by test/lua/recipe_edit_test.lua).
 */
const UPDATE = { class: "MessageBox", name: "MsgBox", title: "Update last object?", text: "FeatureGroup 1 'Dimmer'.Preset 9006 'TEST PH'", buttons: [{ text: "OK", enabled: true }, { text: "Cancel", enabled: true }] };

/**
 * The shapes' value sources as the console reads them (live 2026-11-14): Sine (1) and Linear (2) have one source per
 * step without an attribute filter; Flyout (19) has 3 per step, Dimmer / Tilt / Pan (Tilt widths 100 / 80, Dimmer trans 10).
 */
type FSource = { attribute: string | null; trans: number; width: number };
const PLAIN: FSource[][] = [[{ attribute: null, trans: 100, width: 100 }], [{ attribute: null, trans: 100, width: 100 }]];
const FLYOUT: FSource[][] = [
  [{ attribute: "Dimmer", trans: 10, width: 100 }, { attribute: "Tilt", trans: 100, width: 100 }, { attribute: "Pan", trans: 100, width: 100 }],
  [{ attribute: "Dimmer", trans: 10, width: 100 }, { attribute: "Tilt", trans: 50, width: 80 }, { attribute: "Pan", trans: 50, width: 80 }],
];
/** Chase (7): one source per step, trans 0, and Adaptive Measure / Width on (live 2026-11-14). */
const CHASE: FSource[][] = [[{ attribute: null, trans: 0, width: 100 }], [{ attribute: null, trans: 0, width: 100 }]];
const SHAPES: Record<number, FSource[][]> = { 1: PLAIN, 2: PLAIN, 3: PLAIN, 7: CHASE, 19: FLYOUT, 20: FLYOUT };
const ADAPTIVE_SHAPES = new Set([7]);
const MASTER_NAMES = ["Speed1", "PAN", "TILT", ...Array.from({ length: 13 }, (_, i) => `Speed ${i + 4}`)];
const attrHandle = (a: string | null) => (a ? { class: "Attribute", name: a, addr: `14.9.2.4.${["Dimmer", "Pan", "Tilt"].indexOf(a) + 1}` } : undefined);
/** The children op on "Shape N.1.1" (steps) and "Shape N.1.1.n" (value sources); undefined for any other ref. */
function shapeChildren(ref: string) {
  const list = (items: unknown[]) => ({ total: items.length, offset: 0, count: items.length, items });
  let m = ref.match(/^Shape (\d+)\.1\.1$/);
  if (m) {
    const l = SHAPES[Number(m[1])];
    if (!l) throw new BridgeReplyError(`no object found for '${ref}'`);
    return list(l.map((_, n) => ({ class: "PhaserRecipeStep", index: n + 1, name: `Step ${n + 1}` })));
  }
  m = ref.match(/^Shape (\d+)\.1\.1\.(\d)$/);
  if (m) return list(SHAPES[Number(m[1])][Number(m[2]) - 1].map((x, i) => ({ class: "PhaserRecipeValueSource", index: i + 1, fields: { ATTRIBUTES: attrHandle(x.attribute), TRANSX: x.trans, WIDTHX: x.width } })));
  return undefined;
}

async function setup(o: { pending?: boolean; programmer?: number; shapeFails?: boolean; slotTaken?: boolean } = {}) {
  const h = await startHarness(registerPhaserRecipeTools);
  const c = { editing: false, pz: [] as Array<{ index: number; class: string; name: string }>, modal: false as false | typeof UPDATE, preset: o.slotTaken === true, lines: 0, values: o.programmer ?? 0, pending: o.pending === true, name: "", speed: "60.00" };
  const cmds: string[] = [];
  const pressed: Array<Record<string, unknown>> = [];
  h.fake.onCommand((command) => {
    cmds.push(command);
    if (/^Store Preset 1\.9010 \/NoConfirmation$/.test(command)) {
      c.preset = true;
      c.pending = false;
    } else if (command === "At Shape 1") {
      if (c.editing && !o.shapeFails) {
        c.pz = [{ index: 1, class: "PhaserRecipe", name: "[9000 'TEST PH'/1 'Sine']" }];
        c.values = 8;
      }
    } else if (command === "Store Preset 1.9010 /Merge /NoConfirmation") {
      if (c.pz.length) c.lines = 1;
      c.pz = [];
      c.pending = true;
    } else if (command === "ClearAll") {
      c.values = 0;
      c.pz = [];
    } else if (command === "Delete Preset 1.9010 /NoConfirmation") c.preset = false;
    return "OK";
  });
  h.fake.on("recipe.editState", () => ({ environment: "Normal", editing: c.editing, editingRaw: String(c.editing), partZeroLines: c.pz, modal: c.modal, lastCommand: "OK" }));
  h.fake.on("recipe.editBegin", (args) => {
    assert.equal(args.exclusive, true);
    if (c.pending) c.modal = UPDATE;
    else c.editing = true;
    return { queued: true, command: `EditRecipe ${args.target}` };
  });
  h.fake.on("recipe.editEnd", (args) => {
    assert.equal(args.exclusive, true);
    if (!c.editing) throw new BridgeReplyError("[editing-off] off", "editing-off");
    c.editing = false;
    return { queued: true, command: "EditRecipe" };
  });
  h.fake.on("dialog.press", (args) => {
    pressed.push(args);
    c.modal = false;
    return { clicked: args.button };
  });
  h.fake.on("programmer", () => ({ environment: "Normal", total: c.values, count: 0, coverage: { complete: true }, rows: [] }));
  h.fake.on("preset.context", () => ({ preferencesReadable: true, preferences: { RecipeStoreMode: "Normal" } }));
  h.fake.on("objects", (args) => {
    const known = ["Group 9000", "Shape 1", "MAtricks 9000"].includes(String(args.ref));
    return { total: known ? 1 : 0, items: known ? [{ name: "x" }] : [], offset: 0, count: known ? 1 : 0 };
  });
  const row = (fixture: string) => ({ fixture, attribute: "Dimmer", cooked: true, stepCount: 2, speed: Number(c.speed) / 60, steps: [{ step: 1, integrated: { valid: true, pool: 1, no: 9001 } }, { step: 2, integrated: { valid: true, pool: 1, no: 9000 } }] });
  h.fake.on("preset.read", (args) => {
    const ref = String(args.ref);
    if (ref === "Preset 1.9000" || ref === "Preset 1.9001") return { ref, rows: [], dependencies: [] };
    if (ref === "Preset 1.9010" && c.preset) return { ref, name: c.name, rows: c.lines ? ["1", "2", "3"].map(row) : [], dependencies: [] };
    throw new BridgeReplyError(`no object found for '${ref}'`);
  });
  h.fake.on("children", (args) => shapeChildren(String(args.ref)) ?? { total: c.lines, offset: 0, count: c.lines, items: c.lines ? [{ class: "PhaserRecipe", index: 1, name: "[9000 'TEST PH'/1 'Sine']", fields: { Selection: { class: "Group", index: 9000 }, MAtricks: { class: "MAtrick", index: 9000 }, FailedCookedPart: "None", Enabled: "Yes" } }] : [] });
  h.fake.on("set", (args) => {
    if (args.property === "Name") c.name = String(args.value);
    if (args.property === "SPEEDX") c.speed = `${Number(args.value).toFixed(2)}`;
    return { value: args.property === "Name" ? c.name : `${Number(args.value).toFixed(2)}` };
  });
  return { h, c, cmds, pressed };
}

const ARGS = { action: "create", preset: "1.9010", name: "TEST PH NEW", selection: 9000, steps: [{ preset: "1.9001" }, { preset: "1.9000" }], matricks: 9000, speed_bpm: 120, phase: { from: 0, to: 360 }, exclusive: true };

test("create: empty store first, the build one command at a time, mode off, ClearAll, settings, cook, verified", async () => {
  const { h, c, cmds, pressed } = await setup({ pending: true });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", ARGS);
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, ["Store Preset 1.9010 /NoConfirmation", "Group 9000", "At Shape 1", "Step 1", "At Preset 1.9001", "Step 2", "At Preset 1.9000", "MAtricks 9000", "Store Preset 1.9010 /Merge /NoConfirmation", "ClearAll", "Cook Preset 1.9010 /MergeLowPriority"]);
    assert.deepEqual(pressed, [], "the empty store clears the pending target: no dialog");
    assert.equal(c.editing, false);
    assert.equal(c.name, "TEST PH NEW");
    const sets = h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`);
    assert.deepEqual(sets, ["Preset 1.9010 Name=TEST PH NEW", "Preset 1.9010.1 SPEEDX=120", "Preset 1.9010.1 PHASEFROMX=0", "Preset 1.9010.1 PHASETOX=360"]);
    // EditRecipe is never a plain command (it could stall the bridge behind a dialog).
    assert.ok(!cmds.some((x) => /^EditRecipe/.test(x)));
  } finally {
    await h.close();
  }
});

test("create: refused before anything is sent (programmer not empty, slot taken, wrong pool, 3 steps, no exclusive)", async () => {
  for (const [opts, args, re] of [
    [{ programmer: 4 }, ARGS, /programmer holds 4 value/],
    [{ slotTaken: true }, ARGS, /Preset 1\.9010 exists/],
    [{}, { ...ARGS, steps: [{ preset: "4.9001" }, { preset: "1.9000" }] }, /one family per line.*pools 4 and 1/],
    [{}, { ...ARGS, steps: [{ preset: "1.9001" }, { preset: "1.9000" }, { preset: "1.9000" }] }, /exactly 2/],
    [{}, { ...ARGS, exclusive: undefined }, /exclusive must be true/],
    [{}, { ...ARGS, selection: 9999 }, /not in the show: Group 9999/],
  ] as const) {
    const { h, cmds } = await setup(opts);
    try {
      const { result, isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true);
      assert.match(text, re as RegExp);
      assert.equal(result.outcome, "failed");
      assert.deepEqual(cmds, []);
      assert.ok(!h.fake.requests.some((r) => r.op === "recipe.editBegin"));
    } finally {
      await h.close();
    }
  }
});

test("create: \"Update last object?\" opens anyway -> Cancel (never OK), then the created preset is removed", async () => {
  const { h, c, cmds, pressed } = await setup();
  // The empty store does not clear the pending target in this run.
  h.fake.onCommand((command) => {
    cmds.push(command);
    if (command.startsWith("Store Preset 1.9010 /NoConfirmation")) {
      c.preset = true;
      c.pending = true;
    } else if (command === "Delete Preset 1.9010 /NoConfirmation") c.preset = false;
    else if (command === "ClearAll") c.values = 0;
    return "OK";
  });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", ARGS);
    assert.equal(isError, true, JSON.stringify(result, null, 1));
    assert.equal(pressed.length, 1);
    assert.equal(pressed[0].button, "Cancel");
    assert.equal(pressed[0].expectTitle, "Update last object?");
    assert.match(result.summary, /cancelled \(never OK/);
    assert.deepEqual(cmds, ["Store Preset 1.9010 /NoConfirmation", "ClearAll", "Delete Preset 1.9010 /NoConfirmation"]);
    assert.equal(c.preset, false);
  } finally {
    await h.close();
  }
});

test("create: no line after At Shape -> mode switched off, ClearAll, the preset removed, nothing stored", async () => {
  const { h, c, cmds } = await setup({ shapeFails: true });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", ARGS);
    assert.equal(isError, true);
    assert.match(result.summary, /phaser line was not created/);
    assert.deepEqual(cmds, ["Store Preset 1.9010 /NoConfirmation", "Group 9000", "At Shape 1", "ClearAll", "Delete Preset 1.9010 /NoConfirmation"]);
    assert.ok(h.fake.requests.some((r) => r.op === "recipe.editEnd"));
    assert.equal(c.editing, false);
    assert.equal(c.preset, false);
  } finally {
    await h.close();
  }
});

test("create: a cooked speed that is not the one asked is a mismatch", async () => {
  const { h } = await setup();
  h.fake.on("set", (args) => ({ value: args.property === "Name" ? String(args.value) : `${Number(args.value).toFixed(2)}` })); // the reply matches, the cooked speed stays 60 BPM
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", ARGS);
    assert.equal(isError, true);
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /do not run at 120 BPM \(2\.000 Hz/);
  } finally {
    await h.close();
  }
});

test("create: a phaser preset in another family's pool is allowed (the pool does not filter recipe lines)", async () => {
  const { h } = await multiSetup();
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { ...MULTI, preset: "2.9010", preview: true, exclusive: undefined });
    assert.equal(result.preview, true, JSON.stringify(result));
    assert.equal(result.outcome, "succeeded");
  } finally {
    await h.close();
  }
});

test("preview: a line whose steps come from an All pool is allowed, with a one-family-per-line warning", async () => {
  const { h } = await setup();
  h.fake.on("preset.read", (args) => {
    if (String(args.ref) === "Preset 1.9010") throw new BridgeReplyError("no object found for 'Preset 1.9010'");
    return { ref: args.ref, rows: [], dependencies: [] };
  });
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { ...ARGS, preset: "1.9010", steps: [{ preset: "21.5" }, { preset: "21.6" }], preview: true, exclusive: undefined });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result));
    assert.match(result.warnings.join(" "), /line 1 takes its steps from an All pool \(21\).*one family per line/);
  } finally {
    await h.close();
  }
});

test("preview: checks only, returns the plan", async () => {
  const { h, cmds } = await setup();
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { ...ARGS, exclusive: undefined, preview: true });
    assert.equal(result.preview, true);
    assert.ok(result.plan.some((p: string) => p.startsWith("Cook Preset 1.9010")));
    assert.deepEqual(cmds, []);
  } finally {
    await h.close();
  }
});

test("numberMatches reads the console's formatted replies", () => {
  assert.ok(numberMatches(120, "120.00"));
  assert.ok(numberMatches(360, "360.00°"));
  assert.ok(!numberMatches(360, "180.00"));
  assert.ok(!numberMatches(0, "None"));
});

/** A console with several lines: Copy appends a copy of line 1, Assign Preset at a value source retargets that step. */
async function multiSetup() {
  const s = await setup();
  const { h, c, cmds } = s;
  const lines: string[][] = [];
  const curveSet: Array<{ line: number; step: number; curve: string }> = [];
  const prev = h.fake.handlerFor("cmd")!;
  h.fake.on("cmd", async (args, req) => {
    const command = String(args.command);
    let m: RegExpMatchArray | null;
    if (command === "Store Preset 21.9000 /NoConfirmation") {
      cmds.push(command);
      c.preset = true;
      return { feedback: "OK" };
    }
    if (command === "Store Preset 21.9000 /Merge /NoConfirmation") {
      cmds.push(command);
      if (c.pz.length) lines.push(["1.9001", "1.9000"]);
      c.pz = [];
      return { feedback: "OK" };
    }
    if ((m = command.match(/^Copy Preset 21\.9000\.1 At Preset 21\.9000\.(\d+) \/NoConfirmation$/))) {
      cmds.push(command);
      lines.push([...lines[0]]);
      return { feedback: "OK" };
    }
    if ((m = command.match(/^Assign Preset (\d+\.\d+) At Preset 21\.9000\.(\d+)\.1\.(\d)\.1$/))) {
      cmds.push(command);
      lines[Number(m[2]) - 1][Number(m[3]) - 1] = m[1];
      return { feedback: "OK" };
    }
    if ((m = command.match(/^Set Preset 21\.9000\.(\d+)\.1\.(\d)\.1 Property "Curve" "(.+)"$/))) {
      cmds.push(command);
      curveSet.push({ line: Number(m[1]), step: Number(m[2]), curve: m[3] });
      return { feedback: "OK" };
    }
    return prev(args, req);
  });
  c.lines = 0;
  h.fake.on("children", (args) => shapeChildren(String(args.ref)) ?? { total: lines.length, offset: 0, count: lines.length, items: lines.map((_, i) => ({ class: "PhaserRecipe", index: i + 1, fields: { Selection: { class: "Group", index: 9000 }, MAtricks: { class: "MAtrick", index: 9000 }, FailedCookedPart: "None" } })) });
  const speeds = new Map<number, number>();
  h.fake.on("set", (args) => {
    const m = String(args.ref).match(/^Preset 21\.9000\.(\d+)$/);
    if (m && args.property === "SPEEDX") speeds.set(Number(m[1]), Number(args.value));
    return { value: args.property === "Name" ? String(args.value) : `${Number(args.value).toFixed(2)}` };
  });
  const curveOf = (line: number, step: number) => curveSet.filter((x) => x.line === line && x.step === step).at(-1)?.curve;
  const EFFECT: Record<string, [number, number, number?]> = { Linear: [0, 0], "Ease In": [100, -100], "Ease Out": [-100, 100], "Ease In and Out": [-100, -100], Swing: [100, 100], Snap: [0, 0, 0] };
  h.fake.on("preset.read", (args) => {
    const ref = String(args.ref);
    if (/^Preset (1\.900[01]|4\.900[01])$/.test(ref)) return { ref, rows: [], dependencies: [] };
    if (ref !== "Preset 21.9000" || !c.preset) throw new BridgeReplyError(`no object found for '${ref}'`);
    const rows = lines.flatMap((st, i) =>
      ["1", "2"].map((fixture) => {
        const steps = st.map((p, n) => ({ step: n + 1, integrated: { valid: true, pool: Number(p.split(".")[0]), no: Number(p.split(".")[1]) }, trans: 100, accel: -100, decel: -100 }));
        for (let n = 0; n < 2; n++) {
          const cv = curveOf(i + 1, n + 1);
          if (!cv) continue;
          const [d, a, t] = EFFECT[cv];
          steps[n].decel = d;
          steps[(n + 1) % 2].accel = a;
          if (t !== undefined) steps[n].trans = t;
        }
        return { fixture, attribute: st[0].startsWith("4.") ? "ColorRGB_R" : "Dimmer", cooked: true, stepCount: 2, speed: (speeds.get(i + 1) ?? speeds.get(1) ?? 60) / 60, steps };
      }),
    );
    return { ref, rows, dependencies: [] };
  });
  return { ...s, lines, curveSet };
}

const MULTI = {
  action: "create",
  preset: "21.9000",
  name: "TEST PH DIM COUL",
  lines: [
    { selection: 9000, steps: [{ preset: "1.9001" }, { preset: "1.9000", curve: "snap" }], matricks: 9000, speed_bpm: 120 },
    { selection: 9000, steps: [{ preset: "4.9000" }, { preset: "4.9001" }], matricks: 9000, speed_bpm: 30, phase: { from: 0, to: 180 } },
  ],
  exclusive: true,
};

test("create with lines: line 1 in Edit Recipe mode, line 2 copied and retargeted, each with its speed; curves set and verified", async () => {
  const { h, cmds, lines, curveSet } = await multiSetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", MULTI);
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(lines, [["1.9001", "1.9000"], ["4.9000", "4.9001"]]);
    assert.ok(cmds.includes("Copy Preset 21.9000.1 At Preset 21.9000.2 /NoConfirmation"));
    assert.ok(!cmds.some((x) => /^Assign (Group|MAtricks)/.test(x)), "same group and MAtricks as line 1: nothing to reassign");
    assert.deepEqual(curveSet, [{ line: 1, step: 2, curve: "Snap" }]);
    // A copy keeps its source's custom curves: line 1's are set after line 2 is copied.
    assert.ok(cmds.indexOf('Set Preset 21.9000.1.1.2.1 Property "Curve" "Snap"') > cmds.indexOf("Copy Preset 21.9000.1 At Preset 21.9000.2 /NoConfirmation"));
    assert.equal(cmds.at(-1), "Cook Preset 21.9000 /MergeLowPriority");
    const sets = h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`);
    assert.deepEqual(sets, ["Preset 21.9000 Name=TEST PH DIM COUL", "Preset 21.9000.1 SPEEDX=120", "Preset 21.9000.2 SPEEDX=30", "Preset 21.9000.2 PHASEFROMX=0", "Preset 21.9000.2 PHASETOX=180"]);
  } finally {
    await h.close();
  }
});

test("create with lines: a curve the console did not apply is a mismatch", async () => {
  const { h, curveSet } = await multiSetup();
  const prev = h.fake.handlerFor("cmd")!;
  h.fake.on("cmd", async (args, req) => {
    const r = await prev(args, req);
    if (/Property "Curve"/.test(String(args.command))) curveSet.pop(); // "OK", but nothing changes
    return r;
  });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", MULTI);
    assert.equal(isError, true);
    assert.match(result.verification.detail, /line 1 step 2: 2 value\(s\) do not have the Snap curve/);
  } finally {
    await h.close();
  }
});

test("create with lines: mixed steps, duplicate lines and both forms are refused before anything is sent", async () => {
  for (const [args, re] of [
    [{ ...MULTI, lines: [{ selection: 9000, steps: [{ preset: "1.9001" }, { preset: "4.9000" }] }] }, /one family per line/],
    [{ ...MULTI, lines: [MULTI.lines[0], MULTI.lines[0]] }, /same 2 step presets/],
    [{ ...MULTI, selection: 9000 }, /not both/],
    [{ ...MULTI, lines: [MULTI.lines[0], { ...MULTI.lines[1], matricks: undefined }] }, /give every line one/],
    [{ ...MULTI, lines: [{ ...MULTI.lines[0], steps: [{ preset: "1.9001", curve: "bounce" }, { preset: "1.9000" }] }] }, /input validation failed|curve must be one of/],
  ] as const) {
    const { h, cmds } = await multiSetup();
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true);
      assert.match(text, re as RegExp);
      assert.deepEqual(cmds, []);
    } finally {
      await h.close();
    }
  }
});

// ---- Editing an existing phaser preset (set, add_line, remove_line), against a fake console that models the facts
// verified live on 21.9005 (2026-11-14): Assign retargets a line or a step (a step keeps its curve), a new shape
// recomputes the steps without a custom curve, "Reset" restores the shape's, Copy keeps line 1's custom curves,
// Delete moves the later lines up, and on one fixture and attribute the later line's value wins.
type FStep = { preset: string; accel: number; decel: number; trans: number; custom: boolean };
type FLine = { cls?: string; group: number; shape: number; matricks: number | null; speedHz: number; phaseFrom: number; phaseTo: number; steps: FStep[] };
const SHAPE_CURVE: Record<number, [number, number]> = { 1: [-100, -100], 2: [0, 0] }; // [accel, decel] per step: Sine, Linear
const NAMED: Record<string, [number, number, number?]> = { Linear: [0, 0], "Ease In": [100, -100], "Ease Out": [-100, 100], "Ease In and Out": [-100, -100], Swing: [100, 100], Snap: [0, 0, 0] };
const fstep = (preset: string, shape = 1): FStep => ({ preset, accel: SHAPE_CURVE[shape][0], decel: SHAPE_CURVE[shape][1], trans: 100, custom: false });
const fline = (group: number, a: string, b: string, speedBpm: number): FLine => ({ group, shape: 1, matricks: 9000, speedHz: speedBpm / 60, phaseFrom: 0, phaseTo: 360, steps: [fstep(a), fstep(b)] });

/** A cue part of the fake show (recook): its recipe lines calling a preset and its stored rows. */
type FPart = { part: number; calls: boolean; rows: Array<Record<string, unknown>>; ownNonCooked?: boolean; ownSpeed?: boolean };
type FCue = { seq: number; cue: number; parts: FPart[]; fail?: string };
const P_ADDR = { addr: "14.14.1.5.21.9005", addrNative: "ShowData.DataPools.Default.PresetPools.All.TEST PH EDIT" };

async function editSetup(initial: FLine[], o: { modal?: boolean; editing?: boolean } = {}) {
  const h = await startHarness(registerPhaserRecipeTools);
  const lines: FLine[] = structuredClone(initial);
  const cmds: string[] = [];
  const st = { name: "TEST PH EDIT", ignoreAssignPreset: false, assignGroupToLine1: false };
  const P = "Preset 21.9005";
  /** The cues of the fake show (recook tests): read through ping / children / cueContents / preset.read on a part. */
  const cues: FCue[] = [];
  const cueOf = (ref: string) => {
    const m = ref.match(/^Sequence (\d+) Cue ([\d.]+)(?: Part (\d+))?$/);
    const c = m && cues.find((x) => x.seq === Number(m[1]) && x.cue === Number(m[2]));
    return c ? { c, part: m![3] === undefined ? undefined : c.parts.find((p) => p.part === Number(m![3])) } : undefined;
  };
  const presetRows = () => {
    const out = new Map<string, Record<string, unknown>>();
    lines.forEach((l) => {
      if (l.cls === "StandardRecipe") return;
      for (const fixture of l.group === 9001 ? ["251", "252"] : ["101"]) {
        const attribute = l.steps[0].preset.startsWith("4.") ? "ColorRGB_R" : "Dimmer";
        const steps = l.steps.map((x, n) => ({ step: n + 1, accel: x.accel, decel: x.decel, trans: x.trans, integrated: { valid: true, pool: Number(x.preset.split(".")[0]), no: Number(x.preset.split(".")[1]), addr: `14.14.1.5.${x.preset}` } }));
        out.set(`${fixture}|${attribute}`, { fixture, attribute, cooked: true, stepCount: 2, speed: l.speedHz, steps }); // the later line wins
      }
    });
    return [...out.values()];
  };
  /** What a cue part cooked from the preset holds: the preset's rows, each referencing it. */
  const cookedFromPreset = () => presetRows().map((r) => ({ ...r, absPreset: { valid: true, pool: 21, no: 9005, ...P_ADDR } }));
  h.fake.on("ping", () => ({ bridgeVersion: "0.52.1" }));
  h.fake.on("cueContents", (args) => {
    const f = cueOf(String(args.ref));
    if (!f) throw new BridgeReplyError(`no object found for '${args.ref}'`);
    if (f.c.fail) throw new BridgeReplyError(f.c.fail);
    return {
      ref: args.ref,
      sequence: { name: `Sequence ${f.c.seq}`, tracking: "Yes" },
      cue: { no: String(f.c.cue), name: "TEST" },
      parts: f.c.parts.map((p) => ({ part: p.part, name: "TEST", timing: {}, command: {}, mib: {}, ownDataPresent: p.rows.length > 0, ownNonCookedDataPresent: p.ownNonCooked === true, recipes: p.calls ? [{ index: 1, preset: "TEST PH EDIT", presetRef: { name: "TEST PH EDIT", class: "Preset", ...P_ADDR }, presetResolved: true }] : [], otherChildren: [] })),
      limitations: [],
    };
  });
  const addr = (cls: string, n: number, pool?: number) => ({ class: cls, index: n, addr: `14.14.1.${cls === "Preset" ? `5.${pool}` : 6}.${n}` });
  h.fake.on("recipe.editState", () => ({ environment: "Normal", editing: o.editing === true, partZeroLines: [], partZero: false, modal: o.modal ? UPDATE : false, lastCommand: "OK" }));
  h.fake.on("objects", (args) => {
    const known = ["Group 9000", "Group 9001", "Shape 1", "Shape 2", "MAtricks 9000"].includes(String(args.ref));
    return { total: known ? 1 : 0, items: known ? [{ name: "x" }] : [], offset: 0, count: known ? 1 : 0 };
  });
  h.fake.on("children", (args) => {
    const ref = String(args.ref);
    let m: RegExpMatchArray | null;
    const list = (items: unknown[]) => ({ total: items.length, offset: 0, count: items.length, items });
    const sh = shapeChildren(ref);
    if (sh) return sh;
    if (ref === "DataPool.Sequences") return list([...new Set(cues.map((c) => c.seq))].map((n) => ({ name: `Sequence ${n}`, class: "Sequence", addr: `14.14.1.7.${n}`, index: n })));
    if ((m = ref.match(/^Sequence (\d+)$/))) {
      const mine = cues.filter((c) => c.seq === Number(m![1]));
      if (!mine.length) throw new BridgeReplyError(`no object found for '${ref}'`);
      return list([{ name: "OffCue", class: "Cue", index: 1, fields: { No: null } }, { name: "CueZero", class: "Cue", index: 2, fields: { No: 0 } }, ...mine.map((c, i) => ({ name: `Cue ${c.cue}`, class: "Cue", index: i + 3, fields: { No: Math.round(c.cue * 1000) } }))]);
    }
    const cp = cueOf(ref);
    if (cp?.part) return list(cp.part.calls ? [{ class: "StandardRecipe", index: 1, fields: { SPEEDFROMX: cp.part.ownSpeed ? "2.000000" : "None" } }] : []);
    if (ref === P)
      return list(lines.map((l, i) => ({ class: l.cls ?? "PhaserRecipe", index: i + 1, name: `[${l.group}/${l.shape}]`, fields: { Selection: addr("Group", l.group), MAtricks: l.matricks ? { class: "MAtrick", index: l.matricks, addr: `14.14.1.11.${l.matricks}` } : null, SHAPE: { class: "Shape", index: l.shape, addr: `14.14.1.4.${l.shape}` }, SPEEDX: l.speedHz, PHASEFROMX: l.phaseFrom, PHASETOX: l.phaseTo, FailedCookedPart: "None" } })));
    if ((m = ref.match(/^Preset 21\.9005\.(\d+)\.1$/))) return list(lines[Number(m[1]) - 1].steps.map((_, n) => ({ class: "PhaserRecipeStep", index: n + 1 })));
    if ((m = ref.match(/^Preset 21\.9005\.(\d+)\.1\.(\d)$/))) {
      const x = lines[Number(m[1]) - 1].steps[Number(m[2]) - 1];
      const [pool, no] = x.preset.split(".").map(Number);
      return list([{ class: "PhaserRecipeValueSource", index: 1, fields: { ACCELX: x.accel, DECELX: x.decel, TRANSX: x.trans, Preset: addr("Preset", no, pool) } }]);
    }
    throw new BridgeReplyError(`no object found for '${ref}'`);
  });
  h.fake.on("preset.read", (args) => {
    const ref = String(args.ref);
    if (/^Preset (1\.901[01]|4\.900[01])$/.test(ref)) return { ref, rows: [], dependencies: [] };
    const cp = cueOf(ref);
    if (cp?.part) return { ref, class: "Part", rows: cp.part.rows, dependencies: [], byFixtures: true, count: cp.part.rows.length };
    if (ref !== P) throw new BridgeReplyError(`no object found for '${ref}'`);
    return { ref, name: st.name, ...P_ADDR, referencedBy: 1, rows: presetRows(), dependencies: [] };
  });
  h.fake.on("set", (args) => {
    const m = String(args.ref).match(/^Preset 21\.9005\.(\d+)$/);
    const v = Number(args.value);
    if (args.property === "Name") st.name = String(args.value);
    else if (m && args.property === "SPEEDX") lines[Number(m[1]) - 1].speedHz = v / 60;
    else if (m && args.property === "PHASEFROMX") lines[Number(m[1]) - 1].phaseFrom = v;
    else if (m && args.property === "PHASETOX") lines[Number(m[1]) - 1].phaseTo = v;
    return { value: args.property === "Name" ? st.name : `${v.toFixed(2)}` };
  });
  h.fake.onCommand((command) => {
    cmds.push(command);
    let m: RegExpMatchArray | null;
    if ((m = command.match(/^Assign (Group|Shape|MAtricks) (\d+) At Preset 21\.9005\.(\d+)$/))) {
      const l = lines[(st.assignGroupToLine1 ? 1 : Number(m[3])) - 1];
      if (m[1] === "Group") l.group = Number(m[2]);
      if (m[1] === "MAtricks") l.matricks = Number(m[2]);
      if (m[1] === "Shape") {
        l.shape = Number(m[2]);
        for (const x of l.steps) if (!x.custom) [x.accel, x.decel] = SHAPE_CURVE[l.shape];
      }
    } else if ((m = command.match(/^Assign Preset (\d+\.\d+) At Preset 21\.9005\.(\d+)\.1\.(\d)\.1$/))) {
      if (!st.ignoreAssignPreset) lines[Number(m[2]) - 1].steps[Number(m[3]) - 1].preset = m[1];
    } else if ((m = command.match(/^Set Preset 21\.9005\.(\d+)\.1\.(\d)\.1 Property "Curve" "(.+)"$/))) {
      const l = lines[Number(m[1]) - 1];
      const n = Number(m[2]) - 1;
      const own = l.steps[n];
      const next = l.steps[(n + 1) % 2];
      if (m[3] === "Reset") {
        own.custom = false;
        [, own.decel] = SHAPE_CURVE[l.shape];
        own.trans = 100;
        [next.accel] = SHAPE_CURVE[l.shape];
      } else {
        const [d, a, t] = NAMED[m[3]];
        own.custom = true;
        own.decel = d;
        next.accel = a;
        if (t !== undefined) own.trans = t;
      }
    } else if ((m = command.match(/^Copy Preset 21\.9005\.1 At Preset 21\.9005\.(\d+) \/NoConfirmation$/))) lines.push(structuredClone(lines[0]));
    else if ((m = command.match(/^Delete Preset 21\.9005\.(\d+) \/NoConfirmation$/))) lines.splice(Number(m[1]) - 1, 1);
    return "OK";
  });
  return { h, lines, cmds, st, cues, cookedFromPreset };
}

const DIM_COUL = [fline(9001, "1.9010", "1.9011", 120), fline(9001, "4.9000", "4.9001", 30)];

test("set: step presets, curve and speed on one line, sent as Assign / Set without the programmer, other line unchanged", async () => {
  const { h, lines, cmds } = await editSetup(DIM_COUL);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "4.9001" }, { preset: "4.9000", curve: "swing" }], speed_bpm: 45 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, ["Assign Preset 4.9001 At Preset 21.9005.2.1.1.1", "Assign Preset 4.9000 At Preset 21.9005.2.1.2.1", 'Set Preset 21.9005.2.1.2.1 Property "Curve" "Reset"', 'Set Preset 21.9005.2.1.2.1 Property "Curve" "Swing"', "Cook Preset 21.9005 /MergeLowPriority"]);
    assert.deepEqual(h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`), ["Preset 21.9005.2 SPEEDX=45"]);
    assert.ok(!h.fake.requests.some((r) => /^(programmer|recipe\.edit(Begin|End))$/.test(r.op)), "no programmer, no Edit Recipe mode");
    assert.equal(lines[1].steps[1].decel, 100);
    assert.equal(lines[1].steps[0].accel, 100);
    assert.match(result.warnings.join(" "), /cues that call Preset 21\.9005 were NOT re-cooked.*1 object\(s\) reference Preset 21\.9005/);
    assert.ok(!h.fake.requests.some((r) => /^(cueContents|ping)$/.test(r.op)), "without recook no scan");
  } finally {
    await h.close();
  }
});

test("set: a new shape first, then the curves; a reset goes back to the shape's curve", async () => {
  const start = structuredClone(DIM_COUL);
  Object.assign(start[0].steps[0], { custom: true, decel: 0, trans: 0 }); // Snap on line 1 step 1
  start[0].steps[1].accel = 0;
  const { h, lines, cmds } = await editSetup(start);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", shape: 2, steps: [{ curve: "reset" }, { curve: "ease_out" }] });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, ["Assign Shape 2 At Preset 21.9005.1", 'Set Preset 21.9005.1.1.1.1 Property "Curve" "Reset"', 'Set Preset 21.9005.1.1.2.1 Property "Curve" "Reset"', 'Set Preset 21.9005.1.1.2.1 Property "Curve" "Ease Out"', "Cook Preset 21.9005 /MergeLowPriority"]);
    assert.deepEqual(lines[0].steps.map((x) => [x.accel, x.decel, x.trans]), [[100, 0, 100], [0, -100, 100]]);
    assert.match(result.warnings.join(" "), /new shape recomputes the curves/);
  } finally {
    await h.close();
  }
});

test("add_line: a copy of line 1 retargeted; steps without a curve are reset (a copy keeps line 1's custom curves)", async () => {
  const start = [structuredClone(DIM_COUL[0])];
  Object.assign(start[0].steps[0], { custom: true, decel: 0, trans: 0 });
  start[0].steps[1].accel = 0;
  const { h, lines, cmds } = await editSetup(start);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "add_line", preset: "21.9005", selection: 9000, steps: [{ preset: "4.9000", curve: "ease_in" }, { preset: "4.9001" }], speed_bpm: 30 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, [
      "Copy Preset 21.9005.1 At Preset 21.9005.2 /NoConfirmation",
      "Assign Group 9000 At Preset 21.9005.2",
      "Assign Preset 4.9000 At Preset 21.9005.2.1.1.1",
      "Assign Preset 4.9001 At Preset 21.9005.2.1.2.1",
      'Set Preset 21.9005.2.1.1.1 Property "Curve" "Reset"',
      'Set Preset 21.9005.2.1.2.1 Property "Curve" "Reset"',
      'Set Preset 21.9005.2.1.1.1 Property "Curve" "Ease In"',
      "Cook Preset 21.9005 /MergeLowPriority",
    ]);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1].steps.map((x) => x.trans), [100, 100], "line 1's Snap is not inherited");
    assert.equal(lines[1].speedHz, 0.5);
    assert.equal(lines[1].matricks, 9000, "MAtricks not given: line 1's");
  } finally {
    await h.close();
  }
});

test("remove_line: the line is deleted, the later lines move up and are compared under their new number", async () => {
  const { h, lines, cmds } = await editSetup([...DIM_COUL, fline(9000, "1.9011", "1.9010", 60)]);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "remove_line", preset: "21.9005", line: 2 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, ["Delete Preset 21.9005.2 /NoConfirmation", "Cook Preset 21.9005 /MergeLowPriority"]);
    assert.deepEqual(lines.map((l) => l.group), [9001, 9000]);
  } finally {
    await h.close();
  }
});

test("edit: a line masked on the same fixtures by the edited line may change; other lines' values are still compared", async () => {
  // Line 2 (Dimmer on the same fixtures as line 1) masks line 1; retargeting line 2 to colour unmasks line 1's values.
  const { h } = await editSetup([fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9011", "1.9010", 60)]);
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "4.9000" }, { preset: "4.9001" }] });
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  } finally {
    await h.close();
  }
});

test("edit: a step preset the console did not take, or another line changed, is a mismatch", async () => {
  {
    const { h, st } = await editSetup(DIM_COUL);
    st.ignoreAssignPreset = true;
    try {
      const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "4.9001" }, { preset: "4.9000" }] });
      assert.equal(isError, true);
      assert.match(result.verification.detail, /line 2 step 1 preset reads 4\.9000, 4\.9001 expected/);
    } finally {
      await h.close();
    }
  }
  {
    const { h, st } = await editSetup(DIM_COUL);
    st.assignGroupToLine1 = true;
    try {
      const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, selection: 9000 });
      assert.equal(isError, true);
      assert.match(result.verification.detail, /line 1 selection reads Group 9000, Group 9001 expected/);
      assert.match(result.verification.detail, /value\(s\) of the other lines changed/);
    } finally {
      await h.close();
    }
  }
});

test("edit: refused before anything is sent", async () => {
  const std = [{ ...fline(9001, "1.9010", "1.9011", 60), cls: "StandardRecipe", steps: [] }, DIM_COUL[1]];
  for (const [start, opts, args, re] of [
    [DIM_COUL, {}, { action: "set", preset: "21.9006", speed_bpm: 60 }, /Preset 21\.9006 is not in the show/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005", line: 3, speed_bpm: 60 }, /no line 3/],
    [[DIM_COUL[0]], {}, { action: "remove_line", preset: "21.9005", line: 1 }, /only line .* delete the preset instead/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "1.9010" }, { preset: "1.9011" }] }, /line 1 already has the step presets 1\.9010\/1\.9011/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "1.9010" }, {}] }, /one preset pool .* pools 1 and 4/],
    [DIM_COUL, {}, { action: "add_line", preset: "21.9005", selection: 9001, steps: [{ preset: "1.9010" }, { preset: "1.9011" }] }, /same 2 step presets|already has the step presets/],
    [std, {}, { action: "set", preset: "21.9005", line: 1, speed_bpm: 60 }, /StandardRecipe, not a PhaserRecipe/],
    [[{ ...DIM_COUL[0], steps: [DIM_COUL[0].steps[0]] }, DIM_COUL[1]], {}, { action: "add_line", preset: "21.9005", selection: 9001, steps: [{ preset: "4.9001" }, { preset: "4.9000" }] }, /line 1 of Preset 21\.9005 has 1 step/],
    [[DIM_COUL[0], { ...DIM_COUL[1], steps: [DIM_COUL[1].steps[0]] }], {}, { action: "remove_line", preset: "21.9005", line: 2 }, /line 2 has 1 step/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005" }, /set changes at least one/],
    [DIM_COUL, {}, { action: "remove_line", preset: "21.9005", line: 2, speed_bpm: 60 }, /remove_line takes preset and line only/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005", selection: 9999 }, /not in the show: Group 9999/],
    [DIM_COUL, { editing: true }, { action: "set", preset: "21.9005", speed_bpm: 60 }, /Edit Recipe mode is on/],
    [DIM_COUL, { modal: true }, { action: "set", preset: "21.9005", speed_bpm: 60 }, /a dialog is open/],
  ] as const) {
    const { h, cmds } = await editSetup(start as FLine[], opts);
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true, text);
      assert.match(text, re as RegExp);
      assert.deepEqual(cmds, []);
      assert.ok(!h.fake.requests.some((r) => r.op === "set"));
    } finally {
      await h.close();
    }
  }
});

test("edit preview: checks and the plan, nothing sent", async () => {
  const { h, cmds } = await editSetup(DIM_COUL);
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, name: "X", phase: { from: 0, to: 180 }, preview: true });
    assert.equal(result.preview, true);
    assert.deepEqual(result.plan, ["set Preset 21.9005.2 PHASEFROMX=0", "set Preset 21.9005.2 PHASETOX=180", "set Preset 21.9005 Name=X", "Cook Preset 21.9005 /MergeLowPriority"]);
    assert.deepEqual(cmds, []);
  } finally {
    await h.close();
  }
});

// ---- Several value sources per step (Flyout, shape 19), against a fake console that models the facts verified live
// on 21.9023 / 21.9024 (2026-11-14): At Shape makes a line with the shape's value sources; At Preset in the mode puts
// the preset into every source of the step; Assign Preset At <line>.1.<step>.<source> sets one source; set PRESET ""
// gives the source back its own value; with Link Steps the 2 widths of a source keep their sum; MEASURE cooks x100; a
// source whose preset holds no value for its attribute does not cook (IntegratedPresetMiss).
/** abs / rel: the source's own hard values (a number, "None" for a layer set to None, undefined for the shape's or the preset's). */
type MSource = { attribute: string | null; preset: string | null; trans: number; width: number; abs?: number | "None"; rel?: number | "None" };
type Flag = { value: boolean; own: boolean };
/** transform / style / cols: PHASERTRANSFORM, INVERTSTYLE and the line's own MAtricks columns (null: None). */
type MLine = { group: number; shape: number; matricks: number | null; speedHz: number; measure: number; steps: MSource[][]; am?: Flag; aw?: Flag; master?: number | null; transform?: "Mirror" | "None"; style?: string; cols?: Record<string, number | null> };
const MCOLS = ["XWINGS", "XBLOCK", "XGROUP", "YWINGS", "YBLOCK", "YGROUP", "PHASEFROMY", "PHASETOY"];
const STYLE_ATTRS: Record<string, string[]> = { Pan: ["Pan"], Tilt: ["Tilt"], "P+T": ["Pan", "Tilt"], All: ["Dimmer", "Pan", "Tilt"] };
const HOLDS: Record<string, string[]> = { "1.9020": ["Dimmer"], "1.9021": ["Dimmer"], "2.9020": ["Pan", "Tilt", "PanTiltDistance"], "2.9021": ["Pan", "Tilt", "PanTiltDistance"], "2.9022": ["Pan", "Tilt"] };
const fromShape = (shape: number): MSource[][] => SHAPES[shape].map((st) => st.map((x) => ({ attribute: x.attribute, preset: null, trans: x.trans, width: x.width })));

async function flySetup(initial: MLine[] = [], o: { ignoreSourceAssign?: number; ignoreValues?: boolean; ignoreTransform?: boolean } = {}) {
  const h = await startHarness(registerPhaserRecipeTools);
  const P = "Preset 21.9030";
  const c = { editing: false, pz: null as null | MLine, preset: initial.length > 0, lines: structuredClone(initial), pending: false, name: "", values: 0 };
  const cmds: string[] = [];
  const presetAddr = (p: string) => ({ class: "Preset", index: Number(p.split(".")[1]), addr: `14.14.1.5.${p.split(".")[0]}.${p.split(".")[1]}`, name: p });
  const lineOf = (ref: string) => {
    const m = ref.match(/^Preset 21\.9030\.(\d+)(?:\.1\.(\d)\.(\d))?$/);
    if (!m) return null;
    const l = c.lines[Number(m[1]) - 1];
    return { l, src: m[2] ? l?.steps[Number(m[2]) - 1]?.[Number(m[3]) - 1] : undefined, step: m[2] ? Number(m[2]) - 1 : undefined, s: m[3] ? Number(m[3]) - 1 : undefined };
  };
  h.fake.on("recipe.editState", () => ({ environment: "Normal", editing: c.editing, partZeroLines: c.pz ? [{ index: 1, class: "PhaserRecipe", name: "[9002/19 'Flyout']" }] : [], modal: false, lastCommand: "OK" }));
  h.fake.on("recipe.editBegin", () => {
    c.editing = true;
    return { queued: true };
  });
  h.fake.on("recipe.editEnd", () => {
    c.editing = false;
    return { queued: true };
  });
  h.fake.on("programmer", () => ({ environment: "Normal", total: c.values, count: 0, coverage: { complete: true }, rows: [] }));
  h.fake.on("preset.context", () => ({ preferencesReadable: true, preferences: { RecipeStoreMode: "Normal" } }));
  h.fake.on("objects", (args) => {
    const ref = String(args.ref);
    const sm = ref.match(/^Shape (\d+)\.1$/);
    if (sm && SHAPES[Number(sm[1])]) {
      const yes = ADAPTIVE_SHAPES.has(Number(sm[1])) ? "<Yes>" : "<No>";
      return { total: 1, count: 1, offset: 0, items: [{ name: "PhaserRecipe 1", fields: { PLAYBACKADAPTIVEMEASURE: yes, PLAYBACKADAPTIVEWIDTH: yes } }] };
    }
    const attr = ref.match(/^ShowData\.LivePatch\.AttributeDefinitions\.Attributes\.(\w+)$/);
    const known = ["Group 9002", "Group 9003", "Shape 1", "Shape 7", "Shape 19", "Shape 20", "MAtricks 9000"].includes(ref) || (!!attr && ["Dimmer", "Pan", "Tilt"].includes(attr[1]));
    return { total: known ? 1 : 0, items: known ? [{ name: "x" }] : [], offset: 0, count: known ? 1 : 0 };
  });
  // Adaptive Measure / Width: the console sets the measure to the number of fixtures and step 1's width to 100 / n
  // (the rest to step 2), and ignores MEASURE / WIDTHX meanwhile; a flag the line did not set follows its shape.
  const fixturesOf = (group: number) => (group === 9003 ? ["201"] : ["101", "102"]);
  const shapeFlag = (shape: number): Flag => ({ value: ADAPTIVE_SHAPES.has(shape), own: false });
  const am = (l: MLine) => (l.am ?? shapeFlag(l.shape)).value;
  const aw = (l: MLine) => (l.aw ?? shapeFlag(l.shape)).value;
  const measureOf = (l: MLine) => (am(l) ? fixturesOf(l.group).length : l.measure);
  const widthOf = (l: MLine, step: number, s: number) => (aw(l) ? (step === 0 ? 100 / fixturesOf(l.group).length : 100 - 100 / fixturesOf(l.group).length) : l.steps[step][s].width);
  const flagRead = (f: Flag | undefined, shape: number) => (f?.own ? f.value : `<${shapeFlag(shape).value ? "Yes" : "No"}>`);
  // Mirror (live 2026-11-15, 21.9055 / 21.9073): with XWings 2 the second half of the group runs the other way on the
  // attributes of INVERTSTYLE (Pan by default); XInvW / YInvW read Yes with Mirror and the X / Y wings.
  const mirrored = (l: MLine, fixture: string, attribute: string) => l.transform === "Mirror" && (l.cols?.XWINGS ?? 0) >= 2 && fixturesOf(l.group).indexOf(fixture) >= fixturesOf(l.group).length / 2 && STYLE_ATTRS[l.style ?? "Pan"].includes(attribute);
  h.fake.on("group.read", (args) => {
    const g = Number(String(args.ref).replace(/^Group /, ""));
    return { ref: args.ref, truncated: false, items: fixturesOf(g).map((fixture, i) => ({ fixture, sfIndex: 500 + i })) };
  });
  let step = 0;
  h.fake.onCommand((command) => {
    cmds.push(command);
    let m: RegExpMatchArray | null;
    if (command === "Store Preset 21.9030 /NoConfirmation") c.preset = true;
    else if ((m = command.match(/^Group (\d+)$/))) step = Number(m[1]);
    else if ((m = command.match(/^At Shape (\d+)$/)) && c.editing) {
      c.pz = { group: step, shape: Number(m[1]), matricks: null, speedHz: 1, measure: 4, steps: fromShape(Number(m[1])) };
      c.values = 36;
      step = 0;
    } else if ((m = command.match(/^Step (\d)$/))) step = Number(m[1]);
    else if ((m = command.match(/^At Preset (\d+\.\d+)$/)) && c.pz) for (const x of c.pz.steps[step - 1]) x.preset = m[1]; // every source of the step
    else if ((m = command.match(/^MAtricks (\d+)$/)) && c.pz) c.pz.matricks = Number(m[1]);
    else if (command === "Store Preset 21.9030 /Merge /NoConfirmation" && c.pz) {
      c.lines.push(c.pz);
      c.pz = null;
    } else if (command === "ClearAll") {
      c.values = 0;
      c.pz = null;
    } else if ((m = command.match(/^Assign Preset (\d+\.\d+) At (Preset 21\.9030\.\d+\.1\.\d\.\d)$/))) {
      const x = lineOf(m[2]);
      if (x?.src && x.s !== o.ignoreSourceAssign) Object.assign(x.src, { preset: m[1], abs: undefined, rel: undefined }); // the preset replaces hard values
    } else if ((m = command.match(/^Assign Attribute "(\w+)" At (Preset 21\.9030\.\d+\.1\.\d\.\d)$/))) {
      // One attribute per value source: Assign Attribute on one step sets both (live 2026-11-15).
      const x = lineOf(m[2]);
      if (!x?.src || !["Dimmer", "Pan", "Tilt"].includes(m[1])) return "Illegal object";
      for (const st of x.l.steps) st[x.s!].attribute = m[1];
    } else if ((m = command.match(/^Set (Preset 21\.9030\.\d+\.1\.\d\.\d) Property "(ValueAbsolute|ValueRelative|RawValueAbs|RawValueRel)" "(.*)"$/))) {
      const x = lineOf(m[1]);
      if (!x?.src) return "Illegal object";
      if (!o.ignoreValues) x.src[m[2].endsWith("Abs") || m[2] === "ValueAbsolute" ? "abs" : "rel"] = m[3] === "None" ? "None" : Number(m[3]);
    } else if ((m = command.match(/^Copy Preset 21\.9030\.1 At Preset 21\.9030\.(\d+) \/NoConfirmation$/))) c.lines.push(structuredClone(c.lines[0]));
    else if ((m = command.match(/^Assign Group (\d+) At Preset 21\.9030\.(\d+)$/))) c.lines[Number(m[2]) - 1].group = Number(m[1]);
    else if ((m = command.match(/^Assign Shape (\d+) At Preset 21\.9030\.(\d+)$/))) {
      const l = c.lines[Number(m[2]) - 1];
      l.shape = Number(m[1]);
      if (!l.am?.own) l.am = undefined;
      if (!l.aw?.own) l.aw = undefined;
    }
    else if ((m = command.match(/^Delete Preset 21\.9030\.(\d+) \/NoConfirmation$/))) c.lines.splice(Number(m[1]) - 1, 1);
    else if (command === "Delete Preset 21.9030 /NoConfirmation") c.preset = false;
    return "OK";
  });
  h.fake.on("set", (args) => {
    const ref = String(args.ref);
    const value = String(args.value);
    if (ref === P && args.property === "Name") return { value: (c.name = value) };
    const x = lineOf(ref);
    if (!x?.l) throw new BridgeReplyError(`no object found for '${ref}'`);
    if (x.src && args.property === "PRESET") {
      x.src.preset = null;
      return { value: "", readOk: true };
    }
    if (x.src && args.property === "ATTRIBUTES") {
      for (const st of x.l.steps) st[x.s!].attribute = null;
      return { value: "", readOk: true };
    }
    if (x.src && (args.property === "VALUEABSOLUTE" || args.property === "VALUERELATIVE")) return { value: "0.00", readOk: true }; // the Lua set writes 0 (live 2026-11-15)
    if (x.src && args.property === "TRANSX") return { value: `${(x.src.trans = Number(value)).toFixed(1)}%` };
    if (x.src && args.property === "WIDTHX" && aw(x.l)) return { value: `${widthOf(x.l, x.step!, x.s!).toFixed(1)}%` };
    if (x.src && args.property === "WIDTHX") {
      const other = x.l.steps[(x.step! + 1) % 2][x.s!];
      const sum = x.src.width + other.width;
      x.src.width = Number(value);
      other.width = sum - x.src.width;
      return { value: `${x.src.width.toFixed(1)}%` };
    }
    if (args.property === "SPEEDX") x.l.speedHz = Number(value) / 60;
    if (args.property === "PLAYBACKADAPTIVEMEASURE" || args.property === "PLAYBACKADAPTIVEWIDTH") {
      x.l[args.property === "PLAYBACKADAPTIVEMEASURE" ? "am" : "aw"] = { value: value === "Yes", own: true };
      return { value };
    }
    if (args.property === "SPEEDMASTEROVERRIDE") {
      // A number links master n (0 clears); "None" reads Speed1 (live 2026-11-14).
      const n = value === "None" ? 1 : Number(value);
      if (Number.isInteger(n)) x.l.master = n > 0 ? n : null;
      return { value: x.l.master ? MASTER_NAMES[x.l.master - 1] : "" };
    }
    if (args.property === "MEASURE") {
      if (!am(x.l)) x.l.measure = Number(value);
      return { value: measureOf(x.l).toFixed(2) };
    }
    const prop = String(args.property);
    if (MCOLS.includes(prop)) {
      const col = (x.l.cols = { ...x.l.cols, [prop]: value === "None" ? null : Number(value) })[prop];
      return { value: col === null ? "None" : prop.startsWith("PHASE") ? `${col}°` : String(col), readOk: true };
    }
    if (prop === "PHASERTRANSFORM") {
      // Only the exact names are taken (other text is ignored, live 2026-11-15); Mirror sets INVERTSTYLE Pan.
      if (!o.ignoreTransform && (value === "Mirror" || value === "None")) {
        x.l.transform = value;
        if (value === "Mirror") x.l.style = "Pan";
      }
      return { value: x.l.transform ?? "None", readOk: true };
    }
    // A text INVERTSTYLE does not know is ignored, the previous value stays (live 2026-11-15).
    if (prop === "INVERTSTYLE") return { value: (x.l.style = Object.hasOwn(STYLE_ATTRS, value) ? value : (x.l.style ?? "Pan")), readOk: true };
    return { value: Number(value).toFixed(2) };
  });
  const miss = (l: MLine) => l.steps.some((st) => st.some((x) => x.preset && x.attribute && !HOLDS[x.preset]?.includes(x.attribute)));
  h.fake.on("children", (args) => {
    const ref = String(args.ref);
    const list = (items: unknown[]) => ({ total: items.length, offset: 0, count: items.length, items });
    const sh = shapeChildren(ref);
    if (sh) return sh;
    if (ref === "ShowData.Masters.Speed") return list(MASTER_NAMES.map((name, i) => ({ class: "MasterSpeed", index: i + 1, name, fields: { Name: name } })));
    if (ref === P) {
      if (!c.preset) throw new BridgeReplyError(`no object found for '${ref}'`);
      return list(c.lines.map((l, i) => ({ class: "PhaserRecipe", index: i + 1, fields: { Selection: { class: "Group", index: l.group, addr: `14.14.1.6.${l.group}` }, MAtricks: l.matricks ? { class: "MAtrick", index: l.matricks, addr: `14.14.1.11.${l.matricks}` } : null, SHAPE: { class: "Shape", index: l.shape, addr: `14.14.1.4.${l.shape}` }, SPEEDX: l.speedHz, PHASEFROMX: 0, PHASETOX: 0, MEASURE: `<< ${measureOf(l).toFixed(2)}> 4.00>`, PLAYBACKADAPTIVEMEASURE: flagRead(l.am, l.shape), PLAYBACKADAPTIVEWIDTH: flagRead(l.aw, l.shape), SPEEDMASTEROVERRIDE: l.master ? MASTER_NAMES[l.master - 1] : "", FailedCookedPart: miss(l) ? "IntegratedPresetMiss" : "None", PHASERTRANSFORM: l.transform ?? "None", INVERTSTYLE: l.style ?? "Pan", XINVW: l.transform === "Mirror" && l.cols?.XWINGS != null, YINVW: l.transform === "Mirror" && l.cols?.YWINGS != null, ...Object.fromEntries(MCOLS.map((p) => [p, l.cols?.[p] ?? "None"])) } })));
    }
    let m = ref.match(/^Preset 21\.9030\.(\d+)\.1$/);
    if (m) return list(c.lines[Number(m[1]) - 1].steps.map((_, n) => ({ class: "PhaserRecipeStep", index: n + 1 })));
    m = ref.match(/^Preset 21\.9030\.(\d+)\.1\.(\d)$/);
    if (m) return list(c.lines[Number(m[1]) - 1].steps[Number(m[2]) - 1].map((x, i) => ({ class: "PhaserRecipeValueSource", index: i + 1, fields: { ATTRIBUTES: attrHandle(x.attribute), Preset: x.preset ? presetAddr(x.preset) : undefined, TRANSX: x.trans, WIDTHX: widthOf(c.lines[Number(m![1]) - 1], Number(m![2]) - 1, i), ACCELX: 0, DECELX: 0, VALUEABSOLUTE: x.preset ? `${x.preset} ${x.preset}` : (x.abs ?? "<<0.00>0.00>"), VALUERELATIVE: x.preset ? "" : (x.rel ?? "") } })));
    throw new BridgeReplyError(`no object found for '${ref}'`);
  });
  h.fake.on("preset.read", (args) => {
    const ref = String(args.ref);
    const p = ref.replace(/^Preset /, "");
    if (HOLDS[p]) return { ref, rows: HOLDS[p].map((attribute) => ({ fixture: "101", attribute, value: 0 })), dependencies: [] };
    if (ref !== P || !c.preset) throw new BridgeReplyError(`no object found for '${ref}'`);
    const out = new Map<string, unknown>();
    for (const l of c.lines)
      for (const fixture of fixturesOf(l.group))
        l.steps[0].forEach((_, s) => {
          const srcs = [l.steps[0][s], l.steps[1][s]];
          // A source without an attribute cooks the step preset's first attribute (Dimmer for 1.9020, Pan for 2.9022).
          const attribute = srcs[0].attribute ?? (srcs[0].preset ? HOLDS[srcs[0].preset]?.[0] : undefined) ?? "Dimmer";
          if (srcs.some((x) => x.preset && !HOLDS[x.preset]?.includes(attribute))) return; // IntegratedPresetMiss: nothing cooks
          // A hard value cooks as the step's absolute / relative, a little off as float32 (-20 reads -19.999998807907).
          const f32 = (v: number | "None" | undefined) => (typeof v === "number" ? Math.fround(v) : undefined);
          // The mirrored wing cooks hard values without the step preset: absolute 100 - x, relative -x (a preset's 40 reads 60).
          const mir = mirrored(l, fixture, attribute);
          const mirror = (v: number | "None" | undefined) => (typeof v === "number" ? (x_: "a" | "r") => (x_ === "a" ? 100 - v : -v) : undefined);
          const steps = srcs.map((x, n) => ({
            step: n + 1, trans: x.trans, width: widthOf(l, n, s), accel: 0, decel: 0,
            integrated: x.preset && !mir ? { valid: true, pool: Number(x.preset.split(".")[0]), no: Number(x.preset.split(".")[1]) } : null,
            ...(x.preset ? (mir ? { absolute: f32(60) } : {}) : mir ? { absolute: f32(mirror(x.abs)?.("a")), relative: f32(mirror(x.rel)?.("r")) } : { absolute: f32(x.abs), relative: f32(x.rel) }),
          }));
          // The cooked speed master is 0-based (master 2 reads 1); absent without one.
          out.set(`${fixture}|${attribute}`, { fixture, attribute, cooked: true, stepCount: 2, speed: l.speedHz, measure: measureOf(l) * 100, ...(l.master ? { speedMaster: l.master - 1 } : {}), steps });
        });
    return { ref, name: c.name, referencedBy: 1, rows: [...out.values()], dependencies: [] };
  });
  return { h, c, cmds };
}

const FLY = {
  action: "create",
  preset: "21.9030",
  name: "TEST FLY",
  selection: 9002,
  shape: 19,
  steps: [{ sources: { Dimmer: "1.9020", Tilt: "2.9020" } }, { sources: { Dimmer: "1.9021", Tilt: { preset: "2.9021", width: 70 } }, trans: 40 }],
  matricks: 9000,
  speed_bpm: 34,
  measure: 2,
  exclusive: true,
};

test("create, several value sources: no At Preset in the mode, a preset per source after the store, Pan keeps the shape's value; measure, width and trans set and verified", async () => {
  const { h, c, cmds } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", FLY);
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(cmds, [
      "Store Preset 21.9030 /NoConfirmation",
      "Group 9002",
      "At Shape 19",
      "MAtricks 9000",
      "Store Preset 21.9030 /Merge /NoConfirmation",
      "ClearAll",
      "Assign Preset 1.9020 At Preset 21.9030.1.1.1.1",
      "Assign Preset 2.9020 At Preset 21.9030.1.1.1.2",
      "Assign Preset 1.9021 At Preset 21.9030.1.1.2.1",
      "Assign Preset 2.9021 At Preset 21.9030.1.1.2.2",
      "Cook Preset 21.9030 /MergeLowPriority",
    ]);
    const sets = h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`);
    assert.deepEqual(sets, [
      "Preset 21.9030 Name=TEST FLY",
      "Preset 21.9030.1 SPEEDX=34",
      "Preset 21.9030.1 MEASURE=2",
      "Preset 21.9030.1.1.2.2 WIDTHX=70",
      "Preset 21.9030.1.1.2.1 TRANSX=40",
      "Preset 21.9030.1.1.2.2 TRANSX=40",
      "Preset 21.9030.1.1.2.3 TRANSX=40",
    ]);
    const l = c.lines[0];
    assert.deepEqual(l.steps.map((st) => st.map((x) => x.preset)), [["1.9020", "2.9020", null], ["1.9021", "2.9021", null]]);
    assert.deepEqual(l.steps.map((st) => st[1].width), [110, 70], "Link Steps: Tilt's widths keep their sum (100 + 80)");
    assert.match(result.notes.join(" "), /line 1 Pan: step 1 and step 2 keep\(s\) the shape's value/);
  } finally {
    await h.close();
  }
});

test("create, several value sources: refused before anything is sent", async () => {
  for (const [args, re] of [
    [{ ...FLY, steps: [{ preset: "1.9020" }, { preset: "1.9021" }] }, /step 1 has 3 value sources \(Dimmer, Tilt, Pan\): give steps\[0\]\.sources/],
    [{ ...FLY, steps: [{ sources: { Color: "1.9020" } }, { sources: { Dimmer: "1.9021" } }] }, /no value source .{0,2}Color.{0,2} \(its value sources: Dimmer, Tilt, Pan/],
    [{ ...FLY, steps: [{ sources: { Dimmer: "1.9020", Tilt: "1.9020" } }, { sources: { Dimmer: "1.9021" } }] }, /step 1 Tilt: Preset 1\.9020 holds no Tilt value \(it would not cook: IntegratedPresetMiss\)/],
    [{ ...FLY, steps: [{ sources: { Dimmer: "1.9020", Tilt: "2.9020" }, width: 90 }, { sources: { Dimmer: "1.9021" }, width: 110 }] }, /width given on both steps/],
    [{ ...FLY, steps: [{ sources: { Dimmer: "1.9020", Tilt: "4.9020" } }, { sources: { Dimmer: "1.9021", Tilt: "2.9021" } }] }, /not in the show: Preset 4\.9020/],
    [{ ...FLY, steps: [{ sources: { Dimmer: "1.9020" }, preset: "1.9020" }, { sources: { Dimmer: "1.9021" } }] }, /preset .* or sources .*, not both/],
    [{ ...FLY, steps: undefined, selection: undefined, lines: [{ selection: 9002, shape: 19, steps: FLY.steps, matricks: 9000 }, { selection: 9002, shape: 1, steps: [{ preset: "2.9022" }, { preset: "2.9020" }], matricks: 9000 }], shape: undefined, matricks: undefined, speed_bpm: undefined, measure: undefined }, /Shape 1's value sources \(source 1\) are not line 1's \(Shape 19: Dimmer, Tilt, Pan\)/],
    [{ ...FLY, steps: undefined, selection: undefined, lines: [{ selection: 9002, shape: 19, steps: FLY.steps, matricks: 9000 }, { selection: 9003, shape: 19, steps: [{ sources: { Dimmer: "1.9020" } }, { sources: { Dimmer: "1.9021", Tilt: "2.9020" } }], matricks: 9000 }], shape: undefined, matricks: undefined, speed_bpm: undefined, measure: undefined }, /lines 1 and 2 have the same 2 step presets \(Preset 1\.9020 \/ Preset 1\.9021 on Dimmer\)/],
  ] as const) {
    const { h, cmds } = await flySetup();
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true, text);
      assert.match(text, re as RegExp);
      assert.deepEqual(cmds, []);
    } finally {
      await h.close();
    }
  }
});

test("create, several value sources: a source the console did not take is a mismatch (no cooked Tilt)", async () => {
  const { h } = await flySetup([], { ignoreSourceAssign: 1 });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { ...FLY, measure: undefined, steps: [{ sources: { Dimmer: "1.9020", Tilt: "2.9020" } }, { sources: { Dimmer: "1.9021", Tilt: "2.9021" } }] });
    assert.equal(isError, true);
    assert.match(result.verification.detail, /no cooked value comes from line 1 Tilt \(Preset 2\.9020 \/ Preset 2\.9021\)/);
  } finally {
    await h.close();
  }
});

const FLY_LINE = (): MLine => {
  const steps = fromShape(19);
  [steps[0][0].preset, steps[0][1].preset, steps[1][0].preset, steps[1][1].preset] = ["1.9020", "2.9020", "1.9021", "2.9021"];
  return { group: 9002, shape: 19, matricks: 9000, speedHz: 34 / 60, measure: 4, steps };
};

test("set, several value sources: one source's preset, a cleared source, a width and the measure; the other sources kept", async () => {
  const start = FLY_LINE();
  start.steps[0][2].preset = "2.9020";
  start.steps[1][2].preset = "2.9021";
  const { h, c, cmds } = await flySetup([start]);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", steps: [{ sources: { Tilt: "2.9022", Pan: null } }, { sources: { Tilt: { width: 60 } } }], measure: 8 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(cmds, ["Assign Preset 2.9022 At Preset 21.9030.1.1.1.2", "Cook Preset 21.9030 /MergeLowPriority"]);
    assert.deepEqual(h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`), ["Preset 21.9030.1.1.1.3 PRESET=", "Preset 21.9030.1.1.2.2 WIDTHX=60", "Preset 21.9030.1 MEASURE=8"]);
    assert.deepEqual(c.lines[0].steps.map((st) => st.map((x) => x.preset)), [["1.9020", "2.9022", null], ["1.9021", "2.9021", "2.9021"]]);
    assert.deepEqual(c.lines[0].steps.map((st) => st[1].width), [120, 60]);
    assert.match(result.notes.join(" "), /step 1 Pan/);
  } finally {
    await h.close();
  }
});

test("set, several value sources: one preset for a multi-source step, or a shape with other value sources, is refused", async () => {
  for (const [args, re] of [
    [{ action: "set", preset: "21.9030", steps: [{ preset: "1.9020" }, {}] }, /step 1 has 3 value sources/],
    [{ action: "set", preset: "21.9030", shape: 1 }, /Shape 1's value sources \(source 1\) are not line 1's \(Dimmer, Tilt, Pan\)/],
    [{ action: "set", preset: "21.9030", steps: [{ sources: { Tilt: "1.9021" } }, {}] }, /Preset 1\.9021 holds no Tilt value/],
  ] as const) {
    const { h, cmds } = await flySetup([FLY_LINE()]);
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true, text);
      assert.match(text, re as RegExp);
      assert.deepEqual(cmds, []);
      assert.ok(!h.fake.requests.some((r) => r.op === "set"));
    } finally {
      await h.close();
    }
  }
});

test("set, several value sources: a new shape with the same value sources (Flyout -> Flyout Inverted) keeps the presets", async () => {
  const { h, c, cmds } = await flySetup([FLY_LINE()]);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", shape: 20 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(cmds, ["Assign Shape 20 At Preset 21.9030.1", "Cook Preset 21.9030 /MergeLowPriority"]);
    assert.equal(c.lines[0].shape, 20);
  } finally {
    await h.close();
  }
});

test("add_line, several value sources: a copy of line 1; a source given nothing loses line 1's preset", async () => {
  const { h, c } = await flySetup([FLY_LINE()]);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "add_line", preset: "21.9030", selection: 9003, steps: [{ sources: { Tilt: "2.9021" } }, { sources: { Tilt: "2.9020", Dimmer: "1.9020" } }] });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(c.lines[1].steps.map((st) => st.map((x) => x.preset)), [[null, "2.9021", null], ["1.9020", "2.9020", null]]);
    assert.deepEqual(h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`), ["Preset 21.9030.2.1.1.1 PRESET="]);
  } finally {
    await h.close();
  }
});

test("create with lines, several value sources: line 2 is a copy of line 1; its sources given nothing lose line 1's presets", async () => {
  const { h, c, cmds } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", {
      action: "create",
      preset: "21.9030",
      exclusive: true,
      lines: [
        { selection: 9002, shape: 19, steps: [{ sources: { Dimmer: "1.9020", Tilt: "2.9020", Pan: "2.9020" } }, { sources: { Dimmer: "1.9021", Tilt: "2.9021", Pan: "2.9021" } }], matricks: 9000, speed_bpm: 34 },
        { selection: 9003, shape: 20, steps: [{ sources: { Tilt: "2.9022" } }, { sources: { Tilt: "2.9020" } }], matricks: 9000, speed_bpm: 60, measure: 8 },
      ],
    });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(cmds.slice(cmds.indexOf("Copy Preset 21.9030.1 At Preset 21.9030.2 /NoConfirmation")), [
      "Copy Preset 21.9030.1 At Preset 21.9030.2 /NoConfirmation",
      "Assign Group 9003 At Preset 21.9030.2",
      "Assign Shape 20 At Preset 21.9030.2",
      "Assign Preset 2.9022 At Preset 21.9030.2.1.1.2",
      "Assign Preset 2.9020 At Preset 21.9030.2.1.2.2",
      "Cook Preset 21.9030 /MergeLowPriority",
    ]);
    assert.deepEqual(c.lines[1].steps.map((st) => st.map((x) => x.preset)), [[null, "2.9022", null], [null, "2.9020", null]]);
    assert.deepEqual(h.fake.requests.filter((r) => r.op === "set" && r.args?.property === "PRESET").map((r) => r.args?.ref), ["Preset 21.9030.2.1.1.1", "Preset 21.9030.2.1.1.3", "Preset 21.9030.2.1.2.1", "Preset 21.9030.2.1.2.3"]);
    assert.match(result.notes.join(" "), /line 2 Dimmer: step 1 and step 2 keep\(s\) the shape's value/);
  } finally {
    await h.close();
  }
});

// ---- Speed master per line and the adaptive flags (Chase), against flySetup's console: SPEEDMASTEROVERRIDE n links
// master 3.n and reads its name (0 clears), the cooked speedMaster is 0-based; under Adaptive Measure / Width the
// console sets the measure / widths itself and ignores MEASURE / WIDTHX (live 2026-11-14, Chase on Group 9001).
const setsOf = (h: { fake: { requests: Array<{ op: string; args?: Record<string, unknown> }> } }) => h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`);
const CHASE_ARGS = { action: "create", preset: "21.9030", name: "TEST CHASE", selection: 9002, shape: 7, steps: [{ preset: "1.9020" }, { preset: "1.9021" }], speed_bpm: 60, exclusive: true };
const CHASE_LINE = (o: Partial<MLine> = {}): MLine => {
  const steps = fromShape(7);
  [steps[0][0].preset, steps[1][0].preset] = ["1.9020", "1.9021"];
  return { group: 9002, shape: 7, matricks: null, speedHz: 1, measure: 1, steps, ...o };
};

test("parseSpeedMaster: a master number 1-16; 0 and null clear; text and other numbers are refused", () => {
  for (const [raw, want] of [[2, 2], [16, 16], [1, 1], [0, null], [null, null]] as const) {
    const v = new Validator();
    assert.equal(parseSpeedMaster(v, raw, "speed_master"), want);
    assert.equal(v.ok, true);
  }
  for (const raw of ["2", "PAN", "None", "", 17, -1, 1.5, true]) {
    const v = new Validator();
    assert.equal(parseSpeedMaster(v, raw, "speed_master"), undefined);
    assert.match(v.errors.join(" "), /speed master number 1-16 .*text is refused/);
  }
});

test("yesNoOf: own booleans, inherited <Yes> / <No>, text", () => {
  assert.deepEqual(yesNoOf(true), { value: true, own: true });
  assert.deepEqual(yesNoOf(false), { value: false, own: true });
  assert.deepEqual(yesNoOf("<Yes>"), { value: true, own: false });
  assert.deepEqual(yesNoOf("<No>"), { value: false, own: false });
  assert.deepEqual(yesNoOf("No"), { value: false, own: true });
  assert.equal(yesNoOf(""), undefined);
  assert.equal(yesNoOf(1), undefined);
});

test("create on Chase with measure 1: Adaptive Measure switched off before MEASURE, measure verified, warned", async () => {
  const { h, c } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { ...CHASE_ARGS, measure: 1 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(setsOf(h), ["Preset 21.9030 Name=TEST CHASE", "Preset 21.9030.1 SPEEDX=60", "Preset 21.9030.1 PLAYBACKADAPTIVEMEASURE=No", "Preset 21.9030.1 MEASURE=1"]);
    assert.deepEqual(c.lines[0].am, { value: false, own: true });
    assert.equal(c.lines[0].aw, undefined, "Adaptive Width is left to the shape (one position at a time)");
    assert.match(result.warnings.join(" "), /Shape 7 has Adaptive Measure .* measure 1 switches it off/);
  } finally {
    await h.close();
  }
});

test("create on Chase without measure: the adaptive flags are left to the shape (measure = fixtures)", async () => {
  const { h, c } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", CHASE_ARGS);
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.ok(!setsOf(h).some((x) => /ADAPTIVE|MEASURE/.test(x)));
    assert.equal(c.lines[0].am, undefined);
  } finally {
    await h.close();
  }
});

test("create on Chase: a width needs adaptive_width false (refused otherwise); with it, Adaptive Width goes off before WIDTHX", async () => {
  {
    const { h, cmds } = await flySetup();
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", { ...CHASE_ARGS, steps: [{ preset: "1.9020", width: 50 }, { preset: "1.9021" }] });
      assert.equal(isError, true, text);
      assert.match(text, /Shape 7 has Adaptive Width .* give adaptive_width: false/);
      assert.deepEqual(cmds, []);
    } finally {
      await h.close();
    }
  }
  {
    const { h, cmds } = await flySetup();
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", { ...CHASE_ARGS, adaptive_width: true, steps: [{ preset: "1.9020", width: 50 }, { preset: "1.9021" }] });
      assert.equal(isError, true, text);
      assert.match(text, /a width and adaptive_width: true contradict/);
      const r2 = await h.callJson("gma3_edit_phaser_recipe", { ...CHASE_ARGS, measure: 1, adaptive_measure: true });
      assert.match(r2.text, /measure and adaptive_measure: true contradict/);
      assert.deepEqual(cmds, []);
    } finally {
      await h.close();
    }
  }
  const { h, c } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { ...CHASE_ARGS, adaptive_width: false, steps: [{ preset: "1.9020", width: 50 }, { preset: "1.9021" }] });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    const sets = setsOf(h);
    assert.ok(sets.indexOf("Preset 21.9030.1 PLAYBACKADAPTIVEWIDTH=No") < sets.indexOf("Preset 21.9030.1.1.1.1 WIDTHX=50"), sets.join("\n"));
    assert.deepEqual(c.lines[0].steps.map((st) => st[0].width), [50, 150], "Link Steps: the shape's 100 / 100 keep their sum");
  } finally {
    await h.close();
  }
});

test("create with speed_master: written as a number, read back by the master's name and in the cooked values (0-based)", async () => {
  const { h, c } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { ...FLY, speed_master: 2 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.ok(setsOf(h).includes("Preset 21.9030.1 SPEEDMASTEROVERRIDE=2"));
    assert.equal(c.lines[0].master, 2);
    assert.match(result.warnings.join(" "), /line 1 follows speed master "PAN" with Speed X 34 BPM: the master multiplies Speed X/);
  } finally {
    await h.close();
  }
});

test("create with lines on two masters: each line its master; a line 2 without speed_master keeps line 1's (a copy)", async () => {
  const lines = (m2: unknown) => [
    { selection: 9002, steps: [{ preset: "1.9020" }, { preset: "1.9021" }], speed_bpm: 60, speed_master: 2 },
    { selection: 9003, steps: [{ preset: "1.9021" }, { preset: "1.9020" }], speed_bpm: 60, ...(m2 === undefined ? {} : { speed_master: m2 }) },
  ];
  for (const [m2, want] of [[3, 3], [undefined, 2], [null, null]] as const) {
    const { h, c } = await flySetup();
    try {
      const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "create", preset: "21.9030", exclusive: true, lines: lines(m2) });
      assert.equal(isError, false, JSON.stringify(result, null, 1));
      assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
      assert.equal(c.lines[0].master, 2);
      assert.equal(c.lines[1].master ?? null, want);
      assert.ok(!(result.warnings ?? []).some((w: string) => /multiplies/.test(w)), "Speed X 60: no warning");
    } finally {
      await h.close();
    }
  }
});

test("set speed_master: a new master, master 1 (cooked 0), cleared with 0 or null; a master the console did not take is a mismatch", async () => {
  for (const [sm, sent, want] of [[3, "3", 3], [1, "1", 1], [0, "0", null], [null, "0", null]] as const) {
    const { h, c } = await flySetup([{ ...FLY_LINE(), speedHz: 1, master: 2 }]);
    try {
      const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", speed_master: sm });
      assert.equal(isError, false, JSON.stringify(result, null, 1));
      assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
      assert.deepEqual(setsOf(h), [`Preset 21.9030.1 SPEEDMASTEROVERRIDE=${sent}`]);
      assert.equal(c.lines[0].master ?? null, want);
    } finally {
      await h.close();
    }
  }
  const { h } = await flySetup([{ ...FLY_LINE(), speedHz: 1, master: 2 }]);
  try {
    h.fake.on("set", () => ({ value: "PAN" })); // the console keeps master 2
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", speed_master: 3 });
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /speed master reads "PAN", "TILT" expected/);
    assert.match(result.verification.detail, /do not follow speed master 3 \(first: fixture 101 Dimmer reads master 2\)/);
  } finally {
    await h.close();
  }
});

test("set and add_line keep a line's master: speed only, add_line copies line 1's link; text is refused before anything is sent", async () => {
  {
    const { h, c } = await flySetup([{ ...FLY_LINE(), speedHz: 1, master: 2 }]);
    try {
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", speed_bpm: 120 });
      assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
      assert.equal(c.lines[0].master, 2);
      assert.match(result.warnings.join(" "), /follows speed master "PAN" with Speed X 120 BPM/);
      const add = await h.callJson("gma3_edit_phaser_recipe", { action: "add_line", preset: "21.9030", selection: 9003, steps: [{ sources: { Dimmer: "1.9021" } }, { sources: { Dimmer: "1.9020" } }] });
      assert.equal(add.result.verification.status, "matched", JSON.stringify(add.result.verification));
      assert.equal(c.lines[1].master, 2);
    } finally {
      await h.close();
    }
  }
  for (const sm of ["2", "PAN", "None"]) {
    const { h } = await flySetup([FLY_LINE()]);
    try {
      const { isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", speed_master: sm });
      assert.equal(isError, true);
      assert.ok(!h.fake.requests.some((r) => r.op === "set" || r.op === "cmd"));
    } finally {
      await h.close();
    }
  }
});

test("set on a Chase line: measure switches Adaptive Measure off first; under Adaptive a new group's measure and widths are not compared", async () => {
  {
    const { h, c } = await flySetup([CHASE_LINE()]);
    try {
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", measure: 1 });
      assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
      assert.deepEqual(setsOf(h), ["Preset 21.9030.1 PLAYBACKADAPTIVEMEASURE=No", "Preset 21.9030.1 MEASURE=1"]);
      assert.equal(c.lines[0].am?.value, false);
      assert.match(result.warnings.join(" "), /line 1 had Adaptive Measure .* measure 1 switches it off/);
    } finally {
      await h.close();
    }
  }
  {
    const { h, c } = await flySetup([CHASE_LINE()]);
    try {
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", selection: 9003 });
      assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
      assert.equal(c.lines[0].group, 9003);
    } finally {
      await h.close();
    }
  }
  {
    const { h } = await flySetup([CHASE_LINE()]);
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", steps: [{ width: 50 }, {}] });
      assert.equal(isError, true);
      assert.match(text, /line 1 has Adaptive Width .* give adaptive_width: false/);
      assert.ok(!h.fake.requests.some((r) => r.op === "set" || r.op === "cmd"));
    } finally {
      await h.close();
    }
  }
  const { h, c } = await flySetup([CHASE_LINE()]);
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", adaptive_width: false, steps: [{ width: 50 }, {}] });
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(setsOf(h), ["Preset 21.9030.1 PLAYBACKADAPTIVEWIDTH=No", "Preset 21.9030.1.1.1.1 WIDTHX=50"]);
    assert.deepEqual(c.lines[0].steps.map((st) => st[0].width), [50, 150]);
  } finally {
    await h.close();
  }
});

test("add_line with its own speed_master: the copy of line 1 is relinked, line 1 keeps its master", async () => {
  const { h, c } = await flySetup([{ ...FLY_LINE(), speedHz: 1, master: 2 }]);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "add_line", preset: "21.9030", selection: 9003, steps: [{ sources: { Dimmer: "1.9021" } }, { sources: { Dimmer: "1.9020" } }], speed_master: 3 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.ok(setsOf(h).includes("Preset 21.9030.2 SPEEDMASTEROVERRIDE=3"));
    assert.deepEqual([c.lines[0].master, c.lines[1].master], [2, 3]);
  } finally {
    await h.close();
  }
});

// ---- Hard values in the steps (live 2026-11-15, Rescue 21.9070-21.9072): Assign Attribute once per source (both steps
// share it), PRESET "" on a source that had a preset, then the values from the command line (the Lua set writes 0),
// the layer not given set to None. Relative values are percent of the attribute's whole range.
const HV = { action: "create", preset: "21.9030", name: "TEST HV", selection: 9002, steps: [{ attribute: "Tilt", relative: -20 }, { relative: 20 }], speed_bpm: 30, exclusive: true };
const cmdsAfterClear = (cmds: string[]) => cmds.slice(cmds.indexOf("ClearAll") + 1);

test("create, hard values: no At Preset, Assign Attribute once, the values from the command line with the other layer None, verified", async () => {
  const { h, c, cmds } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", HV);
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(cmds.slice(0, 5), ["Store Preset 21.9030 /NoConfirmation", "Group 9002", "At Shape 1", "Store Preset 21.9030 /Merge /NoConfirmation", "ClearAll"]);
    assert.deepEqual(cmdsAfterClear(cmds), [
      'Assign Attribute "Tilt" At Preset 21.9030.1.1.1.1',
      'Set Preset 21.9030.1.1.1.1 Property "RawValueAbs" "None"',
      'Set Preset 21.9030.1.1.1.1 Property "ValueRelative" "-20"',
      'Set Preset 21.9030.1.1.2.1 Property "RawValueAbs" "None"',
      'Set Preset 21.9030.1.1.2.1 Property "ValueRelative" "20"',
      "Cook Preset 21.9030 /MergeLowPriority",
    ]);
    assert.ok(!setsOf(h).some((x) => /VALUE(ABSOLUTE|RELATIVE)/.test(x)), "values are never written with the Lua set (it writes 0)");
    assert.deepEqual(c.lines[0].steps.map((st) => [st[0].attribute, st[0].abs, st[0].rel]), [["Tilt", "None", -20], ["Tilt", "None", 20]]);
    assert.equal(result.coverage.cooked, 2);
  } finally {
    await h.close();
  }
});

test("create, hard values: a value the console did not take is a mismatch", async () => {
  const { h } = await flySetup([], { ignoreValues: true });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", HV);
    assert.equal(isError, true);
    assert.match(result.verification.detail, /no cooked value comes from line 1 \(relative -20\.00 \/ relative 20\.00\)/);
    assert.match(result.verification.detail, /line 1 step 1 Tilt relative reads none, -20 expected/);
  } finally {
    await h.close();
  }
});

test("create with lines, hard values: line 2 is a copy of a preset line 1, its attribute assigned, its presets cleared, then its values", async () => {
  const { h, c, cmds } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", {
      action: "create",
      preset: "21.9030",
      exclusive: true,
      lines: [
        { selection: 9002, steps: [{ preset: "1.9020" }, { preset: "1.9021" }], speed_bpm: 30 },
        { selection: 9003, steps: [{ attribute: "Pan", absolute: 30 }, { absolute: 70 }], speed_bpm: 20 },
      ],
    });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(cmds.slice(cmds.indexOf("Copy Preset 21.9030.1 At Preset 21.9030.2 /NoConfirmation")), [
      "Copy Preset 21.9030.1 At Preset 21.9030.2 /NoConfirmation",
      "Assign Group 9003 At Preset 21.9030.2",
      'Assign Attribute "Pan" At Preset 21.9030.2.1.1.1',
      'Set Preset 21.9030.2.1.1.1 Property "ValueAbsolute" "30"',
      'Set Preset 21.9030.2.1.1.1 Property "RawValueRel" "None"',
      'Set Preset 21.9030.2.1.2.1 Property "ValueAbsolute" "70"',
      'Set Preset 21.9030.2.1.2.1 Property "RawValueRel" "None"',
      "Cook Preset 21.9030 /MergeLowPriority",
    ]);
    assert.deepEqual(setsOf(h).filter((x) => x.includes("PRESET")), ["Preset 21.9030.2.1.1.1 PRESET=", "Preset 21.9030.2.1.2.1 PRESET="]);
    assert.deepEqual(c.lines[1].steps.map((st) => [st[0].attribute, st[0].preset, st[0].abs]), [["Pan", null, 30], ["Pan", null, 70]]);
    assert.deepEqual(c.lines[0].steps.map((st) => [st[0].attribute, st[0].preset]), [[null, "1.9020"], [null, "1.9021"]]);
  } finally {
    await h.close();
  }
});

test("create, hard values: refused before anything is sent", async () => {
  for (const [args, re] of [
    [{ ...HV, steps: [{ absolute: 10 }, { absolute: 90 }] }, /has hard values but no attribute: give its attribute .* without an attribute or a preset the line does not cook/],
    [{ ...HV, steps: [{ attribute: "NoSuch", absolute: 10 }, { absolute: 90 }] }, /not in the show: attribute .{0,2}NoSuch/],
    [{ ...HV, steps: [{ preset: "1.9020", absolute: 10 }, { absolute: 90 }] }, /give a preset or hard values .*, not both/],
    [{ ...HV, steps: [{ attribute: "Tilt", absolute: 10 }, { attribute: "Pan", absolute: 90 }] }, /attribute .{0,2}Tilt.{0,2} on step 1 and .{0,2}Pan.{0,2} on step 2; a value source has one attribute for both steps/],
    [{ ...HV, steps: [{ attribute: "Tilt", absolute: 120 }, { absolute: 90 }] }, /absolute/],
    [{ ...HV, steps: [{ attribute: null, absolute: 10 }, { absolute: 90 }] }, /attribute null clears a source's attribute with action set/],
    [{ ...HV, shape: 19, steps: [{ sources: { Tilt: { attribute: "Pan", relative: 5 } } }, { sources: { Dimmer: "1.9020" } }] }, /value source 2 is filtered on Tilt by its shape: it cannot take attribute Pan/],
    [{ ...HV, steps: undefined, selection: undefined, speed_bpm: undefined, lines: [{ selection: 9002, steps: HV.steps }, { selection: 9003, steps: [{ preset: "1.9020" }, {}] }] }, /preset|step 2 source 1: line 1 gives it hard values/],
    [{ ...HV, steps: undefined, selection: undefined, speed_bpm: undefined, lines: [{ selection: 9002, steps: HV.steps }, { selection: 9003, steps: HV.steps }] }, /lines 1 and 2 have the same 2 step values \(relative -20\.00 \/ relative 20\.00 on Tilt\)/],
  ] as const) {
    const { h, cmds } = await flySetup();
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true, text);
      assert.match(text, re as RegExp);
      assert.deepEqual(cmds, []);
    } finally {
      await h.close();
    }
  }
});

const HV_LINE = (): MLine => {
  const steps = fromShape(1);
  Object.assign(steps[0][0], { attribute: "Tilt", abs: "None", rel: -20 });
  Object.assign(steps[1][0], { attribute: "Tilt", abs: "None", rel: 20 });
  return { group: 9002, shape: 1, matricks: null, speedHz: 0.5, measure: 1, steps };
};
const PRESET_LINE = (): MLine => {
  const steps = fromShape(1);
  steps[0][0].preset = "1.9020";
  steps[1][0].preset = "1.9021";
  return { group: 9003, shape: 1, matricks: null, speedHz: 0.5, measure: 1, steps };
};

test("set, hard values: new values; a preset line to hard values (attribute, PRESET cleared, values); the other line unchanged", async () => {
  const { h, c, cmds } = await flySetup([HV_LINE(), PRESET_LINE()]);
  try {
    let r = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", steps: [{ absolute: 40 }, { absolute: 60 }] });
    assert.equal(r.isError, false, JSON.stringify(r.result, null, 1));
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.deepEqual(c.lines[0].steps.map((st) => [st[0].abs, st[0].rel]), [[40, "None"], [60, "None"]]);
    cmds.length = 0;
    r = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", line: 2, steps: [{ attribute: "Dimmer", absolute: 10 }, { absolute: 90 }] });
    assert.equal(r.isError, false, JSON.stringify(r.result, null, 1));
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.equal(cmds[0], 'Assign Attribute "Dimmer" At Preset 21.9030.2.1.1.1');
    assert.deepEqual(c.lines[1].steps.map((st) => [st[0].attribute, st[0].preset, st[0].abs]), [["Dimmer", null, 10], ["Dimmer", null, 90]]);
  } finally {
    await h.close();
  }
});

test("set / add_line, hard values: back to the shape's value is refused; a preset line added behind a hard line 1 clears the attribute", async () => {
  const { h, c, cmds } = await flySetup([HV_LINE()]);
  try {
    const refused = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", steps: [{ sources: { 1: null } }, {}] });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /line 1 step 1 Tilt holds hard values: no command takes them back to the shape's value/);
    assert.deepEqual(cmds, []);
    const r = await h.callJson("gma3_edit_phaser_recipe", { action: "add_line", preset: "21.9030", selection: 9003, steps: [{ preset: "1.9020" }, { preset: "1.9021" }] });
    assert.equal(r.isError, false, JSON.stringify(r.result, null, 1));
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.ok(setsOf(h).includes("Preset 21.9030.2.1.1.1 ATTRIBUTES="), setsOf(h).join("; "));
    assert.deepEqual(c.lines[1].steps.map((st) => [st[0].attribute, st[0].preset, st[0].rel]), [[null, "1.9020", undefined], [null, "1.9021", undefined]]);
    const noValues = await h.callJson("gma3_edit_phaser_recipe", { action: "add_line", preset: "21.9030", selection: 9003, steps: [{ attribute: "Tilt" }, { attribute: "Tilt" }] });
    assert.equal(noValues.isError, true);
    assert.match(noValues.text, /holds hard values on line 1 \(the copy keeps them\)/);
  } finally {
    await h.close();
  }
});

// ---- Transform (Mirror) and the line's own MAtricks columns, against the fake's model of the bench (live 2026-11-15,
// Rescue 21.9055 / 21.9073, group 9001 = 251-254): a Lua set of PHASERTRANSFORM / XWINGS / PHASEFROMY reads back
// ("Mirror", "2", "0°"); Mirror sets INVERTSTYLE Pan and XInvW with XWings; on the second wing the cooked values are
// hard, absolute 100 - x / relative -x, without the step preset, on INVERTSTYLE's attributes only.
const MIRROR_LINE = (): MLine => {
  const steps = fromShape(1);
  steps[0][0].preset = "2.9022";
  steps[1][0].preset = "2.9020";
  return { group: 9002, shape: 1, matricks: null, speedHz: 0.5, measure: 1, steps, transform: "Mirror", style: "Pan", cols: { XWINGS: 2 } };
};
const MIRROR = { action: "create", preset: "21.9030", exclusive: true, selection: 9002, shape: 1, steps: [{ preset: "2.9022" }, { preset: "2.9020" }], transform: "mirror", x: { wings: 2 }, phase_y: { from: 0, to: 90 } };

test("create, Mirror: columns, phase Y and Transform set; the mirrored wing's hard values are the line's own; Mirror without wings is warned about", async () => {
  const { h, c } = await flySetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", MIRROR);
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(setsOf(h), ["Preset 21.9030.1 XWINGS=2", "Preset 21.9030.1 PHASEFROMY=0", "Preset 21.9030.1 PHASETOY=90", "Preset 21.9030.1 PHASERTRANSFORM=Mirror"]);
    assert.deepEqual(c.lines[0].cols, { XWINGS: 2, PHASEFROMY: 0, PHASETOY: 90 });
    assert.equal(c.lines[0].style, "Pan");
    // 102 is on the mirrored wing: Pan without the step preset (the fake cooks 60 = 100 - 40).
    const rows = (await h.fake.handlerFor("preset.read")!({ ref: "Preset 21.9030" })) as { rows: Array<{ fixture: string; steps: Array<{ integrated: unknown; absolute?: number }> }> };
    assert.deepEqual(rows.rows.map((r) => [r.fixture, r.steps[0].integrated === null]), [["101", false], ["102", true]]);
    assert.ok(!(result.warnings ?? []).some((w: string) => /without X or Y wings/.test(w)));
  } finally {
    await h.close();
  }
  const noWings = await flySetup();
  try {
    const { result } = await noWings.h.callJson("gma3_edit_phaser_recipe", { ...MIRROR, x: undefined, phase_y: undefined, preview: true });
    assert.match(result.warnings.join(" "), /Transform Mirror without X or Y wings .* nothing is mirrored/);
  } finally {
    await noWings.h.close();
  }
});

test("create, Mirror: a Transform the console did not take, and a copy that keeps line 1's Mirror, are reported", async () => {
  const { h } = await flySetup([], { ignoreTransform: true });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", MIRROR);
    assert.equal(isError, true);
    assert.match(result.failure.error, /PHASERTRANSFORM reads "None" after writing Mirror/);
    assert.match(result.verification.detail, /line 1 transform reads None, Mirror expected/);
  } finally {
    await h.close();
  }
  const two = await flySetup();
  try {
    const lines = [{ selection: 9002, steps: MIRROR.steps, transform: "mirror", x: { wings: 2 } }, { selection: 9003, steps: [{ preset: "1.9020" }, { preset: "1.9021" }] }];
    const { result, isError } = await two.h.callJson("gma3_edit_phaser_recipe", { action: "create", preset: "21.9030", exclusive: true, lines });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.match(result.warnings.join(" "), /line 2 is a copy of line 1 and keeps its Transform Mirror/);
    assert.equal(two.c.lines[1].transform, "Mirror");
  } finally {
    await two.h.close();
  }
});

test("set on a Mirror line: speed changes without a false 'other lines changed'; Transform none switches XInvW off; Tilt mirrors only with invert_style tilt", async () => {
  const { h, c } = await flySetup([MIRROR_LINE(), PRESET_LINE()]);
  try {
    let r = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", speed_bpm: 40 });
    assert.equal(r.isError, false, JSON.stringify(r.result, null, 1));
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    r = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", transform: "none", x: { wings: null } });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.equal(c.lines[0].transform, "None");
    assert.equal(r.result.lines[0].xInvW, false);
    assert.deepEqual(r.result.lines[0].columns.XWINGS, null);
  } finally {
    await h.close();
  }
  const tilt = HV_LINE();
  Object.assign(tilt, { transform: "Mirror", style: "Pan", cols: { XWINGS: 2 } });
  const t = await flySetup([tilt]);
  try {
    // INVERTSTYLE Pan: the Tilt line is not mirrored (both fixtures cook -20 / 20); tilt mirrors 102 (20 / -20).
    let r = await t.h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", speed_bpm: 45 });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    r = await t.h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", invert_style: "tilt", speed_bpm: 50 });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.equal(t.c.lines[0].style, "Tilt");
    assert.equal(r.result.lines[0].invertStyle, "Tilt");
  } finally {
    await t.h.close();
  }
});

test("set / add_line on a Mirror line: new step presets are evidenced by the unmirrored wing; add_line keeps line 1's Mirror (noted)", async () => {
  const { h, c } = await flySetup([MIRROR_LINE()]);
  try {
    let r = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9030", steps: [{ preset: "2.9021" }, {}] });
    assert.equal(r.isError, false, JSON.stringify(r.result, null, 1));
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    r = await h.callJson("gma3_edit_phaser_recipe", { action: "add_line", preset: "21.9030", selection: 9003, steps: [{ preset: "1.9020" }, { preset: "1.9021" }] });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.match(r.result.warnings.join(" "), /line 2 is a copy of line 1 and keeps its Transform Mirror/);
    assert.equal(c.lines[1].transform, "Mirror");
  } finally {
    await h.close();
  }
});

test("Transform and columns: refused before anything is sent", async () => {
  for (const [start, args, re] of [
    [[], { ...MIRROR, matricks: 9000 }, /has MAtricks 9000: a line with a MAtricks object reads its columns/],
    [[], { ...MIRROR, transform: "Mirror" }, /transform[\s\S]*mirror/],
    [[], { ...MIRROR, x: { width: 2 } }, /unrecognized[\s\S]*width/i],
    [[], { ...MIRROR, x: { wings: 1.5 } }, /x\.wings must be an integer/],
    [[], { ...MIRROR, invert_style: "P+T" }, /invert_style/],
    [[FLY_LINE()], { action: "set", preset: "21.9030", x: { wings: 2 } }, /line 1 has MAtricks 9000/],
  ] as const) {
    const { h, cmds } = await flySetup(start as unknown as MLine[]);
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true, text);
      assert.match(text, re as RegExp);
      assert.deepEqual(cmds, []);
      assert.ok(!h.fake.requests.some((x) => x.op === "set"));
    } finally {
      await h.close();
    }
  }
});

// ---- recook: the cue parts that call the edited preset, found with gma3_preset_usage's scan (the real one, against
// editSetup's fake show) and cooked with gma3_cook_recipes (a stub here: it copies the preset's rows into the part,
// as the console's cook does; recipes.test.ts covers the cook itself). A cue does not follow a phaser preset's width
// or trans until it is re-cooked (THK bench 2026-11-15).

/** A cook stub: records the command and, unless `noop`, gives the part the preset's cooked rows. */
function cookStub(s: Awaited<ReturnType<typeof editSetup>>, o: { noop?: boolean; ownNonCooked?: boolean } = {}): RecookDeps {
  return {
    usage: presetUsage,
    cook: async (_ctx, raw) => {
      const t = raw.target as { sequence: number; cue: string; part: number };
      const command = `Cook Sequence ${t.sequence} Cue ${t.cue} Part ${t.part} ${raw.mode === "merge" ? "/Merge" : "/MergeLowPriority"}`;
      s.cmds.push(command);
      const part = s.cues.find((c) => c.seq === t.sequence && String(c.cue) === t.cue)!.parts.find((p) => p.part === t.part)!;
      if (!o.noop) part.rows = s.cookedFromPreset();
      if (o.ownNonCooked) part.ownNonCooked = true;
      return { operation: "cook_recipes", target: {}, outcome: "succeeded", verification: { status: "matched" }, steps: [{ name: "cook", status: "succeeded", command }], summary: "cooked", command };
    },
  };
}
const SET_LINE2 = { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "4.9001" }, { preset: "4.9000", curve: "swing" }], speed_bpm: 45 };

test("recook: the preset is cooked first, then each calling cue part; its cooked values read back as the preset's", async () => {
  const s = await editSetup(DIM_COUL);
  const { h, cmds, cues } = s;
  try {
    cues.push({ seq: 9031, cue: 1, parts: [{ part: 0, calls: true, rows: s.cookedFromPreset() }] });
    const r = await editPhaserRecipe(h.ctx, { ...SET_LINE2, recook: { sequences: [9031] } }, cookStub(s));
    assert.equal(r.verification.status, "matched", JSON.stringify(r, null, 1));
    assert.match(r.verification.checked ?? "", /1 calling cue part\(s\) in Sequence\(s\) 9031 re-cooked \(merge_low_priority\)/);
    assert.deepEqual(cmds.slice(-2), ["Cook Preset 21.9005 /MergeLowPriority", "Cook Sequence 9031 Cue 1 Part 0 /MergeLowPriority"]);
    const rep = r.recook as { complete: boolean; recooked: Array<{ part: string; compared: number; ownNonCookedDataPresent: boolean }>; skipped: unknown[] };
    assert.equal(rep.complete, true);
    assert.deepEqual(rep.recooked.map((x) => [x.part, x.compared, x.ownNonCookedDataPresent]), [["Sequence 9031 Cue 1 Part 0", 4, false]]);
    assert.deepEqual(rep.skipped, []);
    assert.ok(!(r.warnings ?? []).some((w) => /NOT re-cooked/.test(w)));
  } finally {
    await h.close();
  }
});

test("recook: a cue that keeps the old values, or reads OwnNonCookedDataPresent Yes, is a mismatch", async () => {
  for (const [o, re] of [
    [{ noop: true }, /differ from the preset in (preset step 1|speed)/],
    [{ ownNonCooked: true }, /OwnNonCookedDataPresent Yes after the cook/],
  ] as const) {
    const s = await editSetup(DIM_COUL);
    try {
      s.cues.push({ seq: 9031, cue: 1, parts: [{ part: 0, calls: true, rows: s.cookedFromPreset() }] });
      const r = await editPhaserRecipe(s.h.ctx, { ...SET_LINE2, recook: true }, cookStub(s, o));
      assert.equal(r.verification.status, "mismatched");
      assert.match(r.verification.detail ?? "", re);
    } finally {
      await s.h.close();
    }
  }
});

test("recook: a part whose values reference the preset without a recipe line calling it is skipped; other parts unchanged; sequences limit the scan", async () => {
  const s = await editSetup(DIM_COUL);
  try {
    const stored = s.cookedFromPreset().map((r) => ({ ...r, cooked: false }));
    s.cues.push({ seq: 9031, cue: 1, parts: [{ part: 0, calls: true, rows: s.cookedFromPreset() }, { part: 1, calls: false, rows: [{ fixture: "301", attribute: "Dimmer", value: 50, cooked: true }] }] });
    s.cues.push({ seq: 9032, cue: 2, parts: [{ part: 0, calls: false, rows: stored }] });
    s.cues.push({ seq: 9033, cue: 1, parts: [{ part: 0, calls: true, rows: s.cookedFromPreset() }] });
    const r = await editPhaserRecipe(s.h.ctx, { ...SET_LINE2, recook: { sequences: [9031, 9032] } }, cookStub(s));
    assert.equal(r.verification.status, "matched", JSON.stringify(r.verification));
    const rep = r.recook as { recooked: Array<{ part: string }>; skipped: Array<{ part: string; reason: string }> };
    assert.deepEqual(rep.recooked.map((x) => x.part), ["Sequence 9031 Cue 1 Part 0"]);
    assert.equal(rep.skipped.length, 1);
    assert.equal(rep.skipped[0].part, "Sequence 9032 Cue 2 Part 0");
    assert.match(rep.skipped[0].reason, /none of its recipe lines calls it/);
    assert.ok(!s.h.fake.requests.some((q) => q.op === "cueContents" && /^Sequence 9033/.test(String(q.args.ref))), "Sequence 9033 is not in the scope");
    assert.ok(!s.cmds.some((c) => /Sequence 903[23]/.test(c)));
  } finally {
    await s.h.close();
  }
});

test("recook: an edit that did not read back as asked cooks no cue (listed as skipped); an incomplete scan says so", async () => {
  const s = await editSetup(DIM_COUL);
  try {
    s.st.ignoreAssignPreset = true;
    s.cues.push({ seq: 9031, cue: 1, parts: [{ part: 0, calls: true, rows: s.cookedFromPreset() }] });
    s.cues.push({ seq: 9031, cue: 2, parts: [], fail: "cue read failed" });
    const r = await editPhaserRecipe(s.h.ctx, { ...SET_LINE2, recook: true }, cookStub(s));
    assert.equal(r.verification.status, "mismatched");
    const rep = r.recook as { complete: boolean; recooked: unknown[]; skipped: Array<{ part: string; reason: string }> };
    assert.deepEqual(rep.recooked, []);
    assert.match(rep.skipped[0].reason, /did not read back as asked/);
    assert.equal(rep.complete, false);
    assert.match((r.warnings ?? []).join(" "), /search for the cues calling Preset 21\.9005 is incomplete/);
    assert.ok(!s.cmds.some((c) => /^Cook Sequence/.test(c)));
  } finally {
    await s.h.close();
  }
});

test("recook through the tool: preview lists the parts it would cook (nothing sent); create refuses recook", async () => {
  const s = await editSetup(DIM_COUL);
  try {
    s.cues.push({ seq: 9031, cue: 1, parts: [{ part: 0, calls: true, rows: s.cookedFromPreset() }] });
    const { result, isError } = await s.h.callJson("gma3_edit_phaser_recipe", { ...SET_LINE2, recook: { sequences: [9031] }, preview: true });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.deepEqual(result.recook.wouldRecook, ["Sequence 9031 Cue 1 Part 0"]);
    assert.match(result.plan.at(-1), /re-cook \(merge_low_priority\) each calling cue part in Sequence\(s\) 9031: Sequence 9031 Cue 1 Part 0/);
    assert.deepEqual(s.cmds, []);
    const c = await s.h.callJson("gma3_edit_phaser_recipe", { ...ARGS, preset: "1.9010", recook: true });
    assert.equal(c.isError, true);
    assert.match(c.text, /recook is for set, add_line and remove_line/);
    const bad = await s.h.callJson("gma3_edit_phaser_recipe", { ...SET_LINE2, recook: { mode: "overwrite" } });
    assert.equal(bad.isError, true);
  } finally {
    await s.h.close();
  }
});

test("cookedDiff: per fixture and attribute against the preset; a value the preset no longer outputs; a line's own Speed X", () => {
  const P = { addr: "14.14.1.5.21.9075" };
  const ref = { valid: true, addr: P.addr };
  const step = (n: number, width: number, trans: number) => ({ step: n, width, trans, accel: -100, decel: -100, integrated: { valid: true, addr: `p${n}` } });
  const pre = [{ fixture: "251", attribute: "Dimmer", cooked: true, stepCount: 2, speed: 0.1, phase: 0, measure: 100, steps: [step(1, 160, 100), step(2, 40, 100)] }];
  const cue = (w: number, speed = 0.1, extra: Record<string, unknown> = {}) => [{ ...pre[0], speed, absPreset: ref, steps: [step(1, w, 100), step(2, 200 - w, 100)], ...extra }];
  assert.deepEqual(cookedDiff(cue(160), pre, P, { label: "c" }), { compared: 1, problems: [] });
  assert.match(cookedDiff(cue(100), pre, P, { label: "c" }).problems.join(" "), /c: 1 cooked value\(s\) differ from the preset in width step 1 \(first: fixture 251 Dimmer reads 100, the preset 160\)/);
  assert.match(cookedDiff(cue(160, 0.2), pre, P, { label: "c" }).problems.join(" "), /in speed .* reads 12 BPM, the preset 6 BPM/);
  assert.deepEqual(cookedDiff(cue(160, 0.2), pre, P, { label: "c", ignoreSpeed: true }).problems, []);
  assert.match(cookedDiff(cue(160, 0.1, { attribute: "Tilt" }), pre, P, { label: "c" }).problems.join(" "), /no longer outputs/);
  assert.equal(cookedDiff([{ ...cue(100)[0], absPreset: { valid: true, addr: "other" } }], pre, P, { label: "c" }).compared, 0, "a value from another preset is not compared");
});

test("parseRecook: true, {sequences, mode}; other modes, empty lists and unknown keys are refused", () => {
  const p = (raw: unknown) => {
    const v = new Validator();
    const r = parseRecook(v, raw);
    return { r, errors: v.errors };
  };
  assert.deepEqual(p(true).r, { mode: "merge_low_priority" });
  assert.equal(p(false).r, undefined);
  assert.deepEqual(p({ sequences: [9031, 9031], mode: "merge" }).r, { mode: "merge", sequences: [9031] });
  for (const bad of [{ mode: "overwrite" }, { sequences: [] }, { sequence: [1] }, "yes"]) assert.ok(p(bad).errors.length, JSON.stringify(bad));
});
