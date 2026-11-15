import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerFilterTools, filterAttributes } from "../src/tools/filters.ts";

interface Rule { cls: string; applyToFixtures: boolean; invert: boolean; object: string }
interface FakeFilter { name: string; attrs: string[]; rules: Rule[] }

/** A console with presets and a filter pool, as onPC 2.5.1.1 answers (2026-11-15). */
class Console {
  presets = new Map<string, { name: string; attrs: string[] }>([["2.9041", { name: "PAN ONLY", attrs: ["Pan"] }], ["1.9", { name: "EMPTY", attrs: [] }]]);
  filters = new Map<number, FakeFilter>();
  commands: string[] = [];
  /** APPLYTOFIXTURES writes the console ignores. */
  ignoreApply = false;
  /** An Assign that creates a filter with another rule. */
  ruleClass = "FilterRuleUsedInObject";

  install(h: Harness): void {
    h.fake.on("objects", (args) => {
      const m = String(args.ref).match(/^Filter (\d+)$/);
      const f = m ? this.filters.get(Number(m[1])) : undefined;
      if (!f) return { total: 0, count: 0, items: [] };
      return { total: 1, count: 1, items: [{ class: "Filter", index: Number(m![1]), name: f.name, childCount: 1, fields: { Name: f.name, ATTRIBUTES: f.attrs.map((a) => ({ obj: { class: "Attribute", name: a }, name: a })), ABSOLUTE: true, RELATIVE: true, PHASER: true, TIMING: true, HASDYNAMICFILTERRULES: false, HASANYMATRICKSDATA: false, HASACTIVEATTRIBUTEFILTER: true } }] };
    });
    h.fake.on("children", (args) => {
      const m = String(args.ref).match(/^Filter (\d+)\.1\.1$/);
      const f = m ? this.filters.get(Number(m[1])) : undefined;
      if (!f) throw new Error(`no object found for '${args.ref}'`);
      return { total: f.rules.length, offset: 0, count: f.rules.length, items: f.rules.map((r, i) => ({ class: r.cls, index: i + 1, fields: { APPLYTOFIXTURES: r.applyToFixtures, INVERT: r.invert, OBJECT: { class: "Preset", name: r.object } } })) };
    });
    h.fake.on("preset.read", (args) => {
      const k = String(args.ref).replace("Preset ", "");
      const p = this.presets.get(k);
      if (!p) throw new Error(`no object found for '${args.ref}'`);
      return { ref: args.ref, rows: p.attrs.flatMap((a) => ["251", "252"].map((fx) => ({ fixture: fx, attribute: a, value: 50 }))), dependencies: [] };
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      this.commands.push(c);
      const m = c.match(/^Assign Preset (\S+) At Filter (\d+)$/);
      if (!m) throw new Error(`unexpected command ${c}`);
      const p = this.presets.get(m[1])!;
      this.filters.set(Number(m[2]), { name: `Filter ${m[2]}`, attrs: [...p.attrs], rules: [{ cls: this.ruleClass, applyToFixtures: true, invert: false, object: p.name }] });
      return { feedback: "OK" };
    });
    h.fake.on("set", (args) => {
      const ref = String(args.ref);
      const m = ref.match(/^Filter (\d+)(\.1\.1\.1)?$/)!;
      const f = this.filters.get(Number(m[1]))!;
      if (m[2]) {
        if (!this.ignoreApply) f.rules[0].applyToFixtures = args.value === "Yes";
        return { value: f.rules[0].applyToFixtures ? "Yes" : "No", readOk: true };
      }
      f.name = String(args.value);
      return { value: f.name, readOk: true };
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerFilterTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});
const storeFilter = (args: Record<string, unknown>) => h.callJson("gma3_store_filter", args);
const stepError = (r: any, name: string) => r.steps.find((s: { name: string }) => s.name === name)?.error ?? "";

test("filterAttributes reads the ATTRIBUTES handle list and refuses anything else", () => {
  assert.deepEqual(filterAttributes([{ obj: { name: "Pan" }, name: "Pan" }, { obj: { name: "Tilt" } }]), ["Pan", "Tilt"]);
  assert.equal(filterAttributes("0110"), null);
  assert.equal(filterAttributes([{}]), null);
});

test("store_filter: Assign Preset At Filter, APPLYTOFIXTURES No, name; read back matched with the preset's attributes", async () => {
  const { result, isError } = await storeFilter({ filter: 9006, from_preset: "2.9041", name: "F PAN" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.commands, ["Assign Preset 2.9041 At Filter 9006"]);
  const sets = h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args.ref} ${r.args.property}=${r.args.value}`);
  assert.deepEqual(sets, ["Filter 9006.1.1.1 APPLYTOFIXTURES=No", "Filter 9006 Name=F PAN"]);
  assert.deepEqual(result.filter.attributes, ["Pan"]);
  assert.equal(result.filter.notPredictable, undefined);
  assert.equal(con.filters.get(9006)!.rules[0].applyToFixtures, false);
});

test("store_filter refuses an existing slot, a missing or empty preset and a number for the preset, before anything is sent", async () => {
  con.filters.set(9005, { name: "OLD", attrs: ["Pan"], rules: [] });
  const taken = await storeFilter({ filter: 9005, from_preset: "2.9041" });
  assert.equal(taken.isError, true);
  assert.match(stepError(taken.result, "check_slot"), /Filter 9005 exists \(OLD\)/);
  const missing = await storeFilter({ filter: 9006, from_preset: "2.9999" });
  assert.match(stepError(missing.result, "check_preset"), /Preset 2.9999 is not in the show/);
  const empty = await storeFilter({ filter: 9006, from_preset: "1.9" });
  assert.match(stepError(empty.result, "check_preset"), /holds no values/);
  const num = await storeFilter({ filter: 9006, from_preset: 2.9041 });
  assert.equal(num.isError, true);
  assert.match(num.text, /from_preset/);
  assert.equal(con.commands.length, 0);
  const pv = await storeFilter({ filter: 9006, from_preset: "2.9041", preview: true });
  assert.equal(pv.result.preview, true);
  assert.equal(con.commands.length, 0);
});

test("store_filter: an ignored APPLYTOFIXTURES write fails its step and the filter is kept; another rule class stops before it", async () => {
  con.ignoreApply = true;
  const r = await storeFilter({ filter: 9006, from_preset: "2.9041" });
  assert.match(stepError(r.result, "set_apply_to_fixtures"), /APPLYTOFIXTURES reads "Yes"/);
  assert.equal(r.result.verification.status, "mismatched");
  assert.match(r.result.warnings.join(), /Filter 9006 was created and is kept/);
  con.ignoreApply = false;
  con.ruleClass = "FilterRuleAttributes";
  const other = await storeFilter({ filter: 9007, from_preset: "2.9041" });
  assert.match(stepError(other.result, "check_rule"), /not one Used In Object rule/);
  assert.equal(h.fake.requests.filter((q) => q.op === "set" && String(q.args.ref).startsWith("Filter 9007")).length, 0);
});
