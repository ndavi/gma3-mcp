import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerGeneratorTools, generatorAttributes } from "../src/tools/generators.ts";

interface Chan { ATTRIBUTE: string; SPEED: number; RATIO: number; ATTACK: number; DECAY: number; LOWVARIANCE: number; HIGHVARIANCE: number; PHASEVARIANCE: number; SPEEDMASTER: number | null }
const PROPS: Record<string, keyof Chan> = { Speed: "SPEED", Ratio: "RATIO", Attack: "ATTACK", Decay: "DECAY", LowVariance: "LOWVARIANCE", HighVariance: "HIGHVARIANCE", PhaseVariance: "PHASEVARIANCE" };
const MASTERS = ["Speed1", "PAN", "TILT", "Infini"];

/** A generator pool as onPC 2.5.1.1 answers (2026-11-15): new channels with the console's defaults, SpeedMaster 0-based. */
class Console {
  gens = new Map<number, { name: string; channels: Chan[] }>();
  commands: string[] = [];
  programmer = 0;
  programmerComplete = true;
  /** Properties the console answers OK to and does not store. */
  ignore = new Set<string>();
  fresh = (): Chan => ({ ATTRIBUTE: "Dimmer", SPEED: 60, RATIO: 50, ATTACK: 100, DECAY: 100, LOWVARIANCE: 0, HIGHVARIANCE: 0, PHASEVARIANCE: 0, SPEEDMASTER: null });

  install(h: Harness): void {
    h.fake.on("objects", (args) => {
      const m = String(args.ref).match(/^Generator (\d+)$/);
      const g = m ? this.gens.get(Number(m[1])) : undefined;
      if (!g) return { total: 0, count: 0, items: [] };
      return { total: 1, count: 1, items: [{ class: "Random", index: Number(m![1]), name: g.name, childCount: 2, fields: { Name: g.name } }] };
    });
    h.fake.on("children", (args) => {
      const ref = String(args.ref);
      if (ref === "ShowData.Masters.Speed") return { total: 16, offset: 0, count: MASTERS.length, items: MASTERS.map((n, i) => ({ index: i + 1, name: n, fields: { Name: n } })) };
      const m = ref.match(/^Generator (\d+)\.2$/);
      const g = m ? this.gens.get(Number(m[1])) : undefined;
      if (!g) throw new Error(`no object found for '${ref}'`);
      const raw = args.asText === false;
      return {
        total: g.channels.length, offset: 0, count: g.channels.length,
        items: g.channels.map((c, i) => ({
          class: "RandomChannel", index: i + 1,
          fields: {
            // Raw: the name and cycles per minute, percent truncated; text: a handle number, Hz, exact percent.
            ATTRIBUTE: raw ? c.ATTRIBUTE : "#20000087E",
            SPEED: raw ? c.SPEED : (c.SPEED / 60).toFixed(6),
            ...Object.fromEntries(["RATIO", "ATTACK", "DECAY", "LOWVARIANCE", "HIGHVARIANCE", "PHASEVARIANCE"].map((k) => [k, raw ? Math.trunc((c[k as keyof Chan] as number) - 0.001) : (c[k as keyof Chan] as number).toFixed(2)])),
            SPEEDMASTER: c.SPEEDMASTER === null ? "" : MASTERS[c.SPEEDMASTER] ?? `Speed${c.SPEEDMASTER + 1}`,
            LOW: raw ? 0 : "0.00", HIGH: raw ? 100 : "100.00",
          },
        })),
      };
    });
    h.fake.on("programmer", () => ({ total: this.programmer, coverage: { complete: this.programmerComplete }, rows: [] }));
    h.fake.on("set", (args) => {
      const g = this.gens.get(Number(String(args.ref).replace("Generator ", "")))!;
      g.name = String(args.value);
      return { value: g.name, readOk: true };
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      this.commands.push(c);
      let m: RegExpMatchArray | null;
      if ((m = c.match(/^Store Generator (\d+) \/NoConfirmation$/))) {
        this.gens.set(Number(m[1]), { name: `Random ${m[1]}`, channels: [this.fresh()] });
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Store Generator (\d+)\.2\.(\d+) \/NoConfirmation$/))) {
        const g = this.gens.get(Number(m[1]))!;
        if (Number(m[2]) !== g.channels.length + 1) throw new Error("a gap");
        g.channels.push(this.fresh());
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Assign Attribute "(\w+)" At Generator (\d+)\.2\.(\d+)$/))) {
        if (m[1] === "Bogus") return { feedback: "Illegal object" };
        this.gens.get(Number(m[2]))!.channels[Number(m[3]) - 1].ATTRIBUTE = m[1];
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Set Generator (\d+)\.2\.(\d+) Property "(\w+)" "([^"]*)"$/))) {
        const ch = this.gens.get(Number(m[1]))!.channels[Number(m[2]) - 1];
        if (this.ignore.has(m[3])) return { feedback: "OK" };
        if (m[3] === "SpeedMaster") ch.SPEEDMASTER = m[4] === "None" ? null : Number(m[4]);
        else (ch as unknown as Record<string, number>)[PROPS[m[3]]] = Math.min(Number(m[4]), m[3] === "PhaseVariance" ? 360 : m[3] === "Speed" ? 1e9 : 100);
        return { feedback: "OK" };
      }
      throw new Error(`unexpected command ${c}`);
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerGeneratorTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});
const store = (args: Record<string, unknown>) => h.callJson("gma3_store_generator", args);
const stepError = (r: any, name: string) => r.steps.find((s: { name: string }) => s.name === name)?.error ?? "";

test("create: Store Generator, a Store per further channel, Assign Attribute and one Set per setting; read back matched", async () => {
  const { result, isError } = await store({
    generator: 9004, action: "create", name: "RND DIM PAN",
    channels: [
      { attribute: "Dimmer", speed: 15, ratio: 20, attack: 0, decay: 0, low_variance: 100, high_variance: 100, phase_variance: 360, speed_master: 2 },
      { attribute: "Pan", speed: 7.5, ratio: 33.3 },
    ],
  });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.commands, [
    "Store Generator 9004 /NoConfirmation",
    'Assign Attribute "Dimmer" At Generator 9004.2.1',
    'Set Generator 9004.2.1 Property "Speed" "15"',
    'Set Generator 9004.2.1 Property "Ratio" "20"',
    'Set Generator 9004.2.1 Property "Attack" "0"',
    'Set Generator 9004.2.1 Property "Decay" "0"',
    'Set Generator 9004.2.1 Property "LowVariance" "100"',
    'Set Generator 9004.2.1 Property "HighVariance" "100"',
    'Set Generator 9004.2.1 Property "PhaseVariance" "360"',
    'Set Generator 9004.2.1 Property "SpeedMaster" "1"',
    "Store Generator 9004.2.2 /NoConfirmation",
    'Assign Attribute "Pan" At Generator 9004.2.2',
    'Set Generator 9004.2.2 Property "Speed" "7.5"',
    'Set Generator 9004.2.2 Property "Ratio" "33.3"',
  ]);
  const [c1, c2] = result.generator.channels;
  assert.equal(c1.attribute, "Dimmer");
  assert.equal(c1.speed, 15, "speed in cycles per minute, from the raw read");
  assert.equal(c1.ratio, 20, "percent from the text read (the raw one is truncated)");
  assert.equal(c1.speedMaster, "PAN", "master 3.2 is sent as 1 and reads by name");
  assert.equal(c2.ratio, 33.3);
  assert.equal(c2.attack, 100, "a new channel keeps the console's default");
  assert.equal(result.generator.name, "RND DIM PAN");
  assert.match(result.warnings.join(), /takes effect at the next Goto/);
  assert.deepEqual(generatorAttributes({ no: 9004, exists: true, channels: result.generator.channels }), { attributes: ["Dimmer", "Pan"] });
});

test("create refuses an existing slot, a programmer that holds values or cannot be read, before anything is sent", async () => {
  con.gens.set(9001, { name: "Random 9001", channels: [con.fresh()] });
  const taken = await store({ generator: 9001, action: "create", channels: [{ attribute: "Dimmer" }] });
  assert.match(stepError(taken.result, "read_generator"), /Generator 9001 exists \(Random 9001\)/);
  con.programmer = 3;
  const busy = await store({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer" }] });
  assert.equal(busy.isError, true);
  assert.match(stepError(busy.result, "check_programmer"), /holds 3 value\(s\).*never clears the programmer/);
  con.programmer = 0;
  con.programmerComplete = false;
  const unknown = await store({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer" }] });
  assert.match(stepError(unknown.result, "check_programmer"), /not known to be empty/);
  assert.equal(con.commands.length, 0);
  assert.equal(h.fake.requests.filter((r) => r.op === "programmer").length, 2, "checked once per call that would store");
});

test("validation: ranges, attribute on create, channel order, speed master, edit fields", async () => {
  const bad = async (args: Record<string, unknown>, re: RegExp) => {
    const r = await store(args);
    assert.equal(r.isError, true);
    assert.match(`${r.result?.summary ?? ""} ${r.text}`, re);
  };
  await bad({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer", ratio: 150 }] }, /ratio/);
  await bad({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer", phase_variance: 400 }] }, /phase_variance/);
  await bad({ generator: 9004, action: "create", channels: [{ speed: 15 }] }, /attribute is required on create/);
  await bad({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer", channel: 2 }] }, /channels are 1, 2, \.\.\. in list order/);
  await bad({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer", speed_master: 17 }] }, /speed master number 1-16/);
  await bad({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer", width: 3 }] }, /unrecognized_keys[\s\S]*width/);
  await bad({ generator: 9004, action: "create" }, /create needs channels/);
  await bad({ generator: 9004, action: "edit", channels: [{ speed: 15 }] }, /channel is required on edit/);
  await bad({ generator: 9004, action: "edit", channels: [{ channel: 1 }] }, /changes nothing/);
  await bad({ generator: 9004, action: "move" }, /invalid_value[\s\S]*"create"/);
  assert.equal(con.commands.length, 0);
});

test("edit: settings of one channel and a new channel at count + 1; the other channels unchanged; no Store, no programmer check without one", async () => {
  con.gens.set(9002, { name: "Random 9002", channels: [con.fresh(), { ...con.fresh(), ATTRIBUTE: "Pan" }] });
  const set = await store({ generator: 9002, action: "edit", channels: [{ channel: 2, speed: 30, speed_master: null }] });
  assert.equal(set.result.verification.status, "matched", JSON.stringify(set.result.verification));
  assert.deepEqual(con.commands, ['Set Generator 9002.2.2 Property "Speed" "30"', 'Set Generator 9002.2.2 Property "SpeedMaster" "None"']);
  assert.equal(h.fake.requests.filter((r) => r.op === "programmer").length, 0);
  con.commands = [];
  const add = await store({ generator: 9002, action: "edit", channels: [{ channel: 3, attribute: "Tilt", ratio: 10 }] });
  assert.equal(add.result.verification.status, "matched", JSON.stringify(add.result.verification));
  assert.deepEqual(con.commands, ["Store Generator 9002.2.3 /NoConfirmation", 'Assign Attribute "Tilt" At Generator 9002.2.3', 'Set Generator 9002.2.3 Property "Ratio" "10"']);
  const gap = await store({ generator: 9002, action: "edit", channels: [{ channel: 5, attribute: "Tilt" }] });
  assert.match(stepError(gap.result, "read_generator"), /has 3 channel\(s\): a new channel is 4/);
  const bare = await store({ generator: 9002, action: "edit", channels: [{ channel: 4, speed: 10 }] });
  assert.match(stepError(bare.result, "read_generator"), /channel 4 is new: it needs its attribute/);
  const missing = await store({ generator: 9009, action: "edit", channels: [{ channel: 1, speed: 10 }] });
  assert.match(stepError(missing.result, "read_generator"), /Generator 9009 is not in the show/);
});

test("a setting the console ignores is a mismatch; a refused attribute stops the channel and the generator is kept", async () => {
  con.ignore.add("Ratio");
  const r = await store({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer", ratio: 20 }] });
  assert.equal(r.result.verification.status, "mismatched");
  assert.match(r.result.verification.detail, /channel 1 ratio reads 50, 20 expected/);
  const bogus = await store({ generator: 9005, action: "create", channels: [{ attribute: "Bogus", speed: 15 }] });
  assert.equal(bogus.isError, true);
  assert.match(stepError(bogus.result, "channel_1_assign_attribute"), /Illegal object/);
  assert.equal(bogus.result.steps.find((s: { name: string }) => s.name === "channel_1_set_speed").status, "skipped");
  assert.match(bogus.result.warnings.join(), /Generator 9005 was created and is kept/);
});

test("a speed master that is not in the show is refused; preview sends nothing", async () => {
  const r = await store({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer", speed_master: 9 }] });
  assert.match(stepError(r.result, "check_speed_masters"), /speed master\(s\) 3.9 not in the show/);
  const pv = await store({ generator: 9004, action: "create", channels: [{ attribute: "Dimmer", speed: 15 }], preview: true });
  assert.equal(pv.result.preview, true);
  assert.deepEqual(pv.result.intended.commands, ["Store Generator 9004 /NoConfirmation", 'Assign Attribute "Dimmer" At Generator 9004.2.1', 'Set Generator 9004.2.1 Property "Speed" "15"']);
  assert.equal(con.commands.length, 0);
});
