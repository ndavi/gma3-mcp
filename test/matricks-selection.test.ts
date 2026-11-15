import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveSettings, parseSelectionSettings, selectMembers, describeSelection, type GridMember } from "../src/tools/matricksselection.ts";

// The bench groups of onPC 2.5.1 ("Rescue", 2026-11-15), stored order and grid x as group.read gives them.
// Group 9001: 252, 251, 253, 254 with x 1, 0, 2, 3. Group 9005: 2..12 with x 1..11, then 1 with x 0.
const G9001: GridMember[] = [{ fixture: "252", sfIndex: 524, x: 1, y: 0, z: 0 }, { fixture: "251", sfIndex: 525, x: 0, y: 0, z: 0 }, { fixture: "253", sfIndex: 526, x: 2, y: 0, z: 0 }, { fixture: "254", sfIndex: 530, x: 3, y: 0, z: 0 }];
const G9005: GridMember[] = [...Array.from({ length: 11 }, (_, i) => ({ fixture: String(i + 2), sfIndex: i + 2, x: i + 1, y: 0, z: 0 })), { fixture: "1", sfIndex: 1, x: 0, y: 0, z: 0 }];

/** Settings as a MAtricks object reads them through the objects op (display text). */
const obj = (props: Record<string, string>) => parseSelectionSettings(props);
const kept = (members: GridMember[], props: Record<string, string>) => {
  const s = selectMembers(members, obj(props));
  return s.kind === "subset" ? s.kept.map((m) => m.fixture) : s.kind;
};

test("selectMembers: the X select keeps the cooked fixtures of every bench case (grid order, wings, blocks, groups)", () => {
  // Sequence 9033 cues 1, 3, 6, 8, 4, 5, 7 and Sequence 9019 cues 9, 10, 2; preset 21.9048 / 21.9049.
  assert.deepEqual(kept(G9001, { X: "1", XGroup: "2" }), ["251", "253"]);
  assert.deepEqual(kept(G9001, { X: "3" }), ["253"]);
  assert.deepEqual(kept(G9001, { X: "2", XBlock: "2" }), ["253", "254"]);
  assert.deepEqual(kept(G9001, { X: "2", XGroup: "2" }), ["252", "254"]);
  assert.deepEqual(kept(G9001, { X: "3", XGroup: "2" }), [], "past the last group: nothing (no wrap-around)");
  assert.deepEqual(kept(G9001, { X: "4", XBlock: "2" }), [], "past the last block: nothing");
  assert.deepEqual(kept(G9005, { X: "1", XGroup: "3" }), ["1", "4", "7", "10"]);
  assert.deepEqual(kept(G9005, { X: "4", XBlock: "2" }), ["7", "8"]);
  assert.deepEqual(kept(G9005, { X: "2", XWings: "2" }), ["2", "11"], "wing 2 counts down: x 1 and x 10 share position 1");
  assert.deepEqual(kept(G9005, { X: "2", XBlock: "4", XWings: "2" }), ["5", "6", "7", "8"]);
  assert.deepEqual(kept(G9005, { X: "2", XBlock: "4" }), ["5", "6", "7", "8"]);
  assert.deepEqual(kept(G9005, { X: "2", XBlock: "2", XGroup: "3" }), ["3", "4", "9", "10"], "(i // 2) % 3 = 1");
});

test("selectMembers: the kept position and the number of positions", () => {
  const s = selectMembers(G9005, obj({ X: "2", XBlock: "4", XWings: "2" }));
  assert.equal(s.kind, "subset");
  if (s.kind !== "subset") return;
  assert.equal(s.position, 1);
  assert.equal(s.positions, 2);
  assert.equal(s.shared, true);
  assert.deepEqual(s.dropped.map((m) => m.fixture), ["1", "2", "3", "4", "9", "10", "11", "12"]);
  const g = selectMembers(G9001, obj({ X: "1", XGroup: "6" }));
  assert.equal(g.kind === "subset" && g.positions, null, "more groups than positions: the count is not known");
});

test("selectMembers: no select keeps everyone; unverified settings and grids are not predicted, with the reason", () => {
  assert.equal(kept(G9001, { X: "None", XWings: "2", XBlock: "2" }), "all");
  assert.equal(kept(G9001, {}), "all");
  const why = (members: GridMember[], props: Record<string, string>) => {
    const s = selectMembers(members, obj(props));
    return s.kind === "unpredicted" ? s.why : s.kind;
  };
  assert.match(why(G9001, { Y: "1" }), /a Y or Z select is not verified \(Y 1\)/);
  assert.match(why(G9001, { X: "1", YBlock: "2" }), /Y or Z wings, blocks or groups/);
  assert.match(why(G9001, { X: "1", XWidth: "2" }), /XWidth, XShift or XShuffle/);
  assert.match(why(G9001, { X: "1", XShuffle: "3" }), /XWidth, XShift or XShuffle/);
  assert.match(why(G9001, { X: "1", XInvB: "Yes" }), /an invert or the Mirror transform/);
  assert.match(why(G9001, { X: "1", PhaserTransform: "Mirror" }), /an invert or the Mirror transform/);
  assert.match(why(G9001, { X: "1", Active: "No" }), /not active/);
  assert.match(why(G9005.slice(0, 7).map((m, i) => ({ ...m, x: i })), { X: "1", XWings: "2" }), /XWings 2 on 7 fixtures \(not a multiple\)/);
  assert.match(why(G9001.map((m, i) => ({ ...m, y: i % 2 })), { X: "1" }), /more than one row/);
  assert.match(why(G9001.map((m) => ({ ...m, x: m.x! * 2 })), { X: "1" }), /gaps or shared cells/);
  assert.match(why(G9001.map(({ fixture, sfIndex }) => ({ fixture, sfIndex })), { X: "1" }), /grid cells were not read/);
  assert.match(why(G9001, { X: "abc" }), /could not be read/);
});

test("parseSelectionSettings reads both roles: typed line fields, display text, and a column inherited from the object", () => {
  const typed = parseSelectionSettings({ X: 2, XBlock: 2, XGroup: "None", PhaseFromX: 0, PhaseToX: 360, XInv: false, PhaserTransform: "None", RelativePhase: true });
  assert.equal(describeSelection(typed), "X 2, XBlock 2");
  assert.deepEqual([typed.axes.X.phaseFrom, typed.axes.X.phaseTo, typed.axes.X.inverted, typed.transform, typed.relativePhase], [0, 360, false, false, true]);
  const text = parseSelectionSettings({ X: "1", XGroup: "2", XBlock: "None", PhaseFromX: "None", XInvW: "No", Active: "Yes" });
  assert.equal(describeSelection(text), "X 1, XGroup 2");
  assert.equal(text.active, true);
  assert.equal(describeSelection(parseSelectionSettings({ X: "<2>" }, { inheritedIsNone: true })), "", "an inherited column is the object's");
  assert.equal(describeSelection(parseSelectionSettings({ X: 0, XBlock: "0" })), "", "0 is None");
});

test("effectiveSettings: the object's settings, or not predicted when the line has its own select as well", () => {
  const info = (props: Record<string, string>) => ({ exists: true, settings: obj(props), name: "M" });
  const own = parseSelectionSettings({ X: 1 });
  const e1 = effectiveSettings(undefined, { no: 9009, info: info({ X: "1", XGroup: "2" }) });
  assert.ok("settings" in e1 && e1.settings && describeSelection(e1.settings) === "X 1, XGroup 2" && e1.source === 'MAtricks 9009 "M"');
  assert.match((effectiveSettings(own, { no: 9010, info: info({ XWings: "2" }) }) as { why: string }).why, /own MAtricks columns \(X 1\) and MAtricks 9010 \(XWings 2\)/);
  assert.match((effectiveSettings(undefined, { no: 9, info: { exists: false } }) as { why: string }).why, /MAtricks 9 could not be read/);
  const spread = effectiveSettings(parseSelectionSettings({ PhaseFromX: 0, PhaseToX: 90 }), { no: 9010, info: info({ XWings: "2" }) });
  assert.ok("settings" in spread && spread.settings === null, "both only spread: every member keeps its values");
  assert.ok("settings" in effectiveSettings(own, null));
});
