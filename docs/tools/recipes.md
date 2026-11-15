# Recipes and cooking (SB-05)

These tools combine groups, presets and MAtricks into programming that adapts to a changed rig:
- `gma3_recipes` reads the recipe lines of a preset or cue part and what the target holds;
- `gma3_edit_recipe` adds, changes, moves or removes one line;
- `gma3_store_recipe_cues` writes the lines of many cue parts in one call (a recipe-driven show build, #101);
- `gma3_cook_recipes` cooks a preset, a cue part, a cue or a whole sequence with an explicit option, after listing
  every affected target;
- `gma3_edit_phaser_recipe` builds phaser recipe lines (one family per line, several families in one preset, or a
  preset per value source on a shape with several, such as Flyout: Dimmer + Tilt in one line) in a free preset slot, through the programmer's Edit Recipe mode, and edits an existing phaser preset (a line's
  settings, add or remove a line) without the programmer (bridge **0.52.1**);
- `gma3_store_filter` creates a filter from a preset, for a line's `filter` (the line then cooks only the filter's
  attributes).

Recipe definitions are read and written with the existing object ops (`children`, `objects`, `set`) and `Assign` /
`Move` / `Delete` / `Cook` commands. The cooked state of a target comes from `preset.read`, which bridge **0.24.0**
extends to cue parts (see [the bridge protocol](../reference.md#cue-part-data-plugin-v0240-sb-05)). Evidence:
[the SB-05 probe record](../probes/sb-05-recipes-macos-2.5.1.md).

| Tool | Changes | Programmer |
| --- | --- | --- |
| `gma3_recipes` | nothing (read-only) | untouched |
| `gma3_edit_recipe` | one recipe line of a preset or cue part; **the console cooks the edited line at once** | untouched |
| `gma3_store_recipe_cues` | the recipe lines of up to 100 cue parts of one sequence, their cue names and notes; each written line is cooked at once, as above | untouched |
| `gma3_cook_recipes` | the cooked (and, with merge or overwrite, the uncooked) data of the affected targets | untouched |
| `gma3_edit_phaser_recipe` | create: one preset with 1-8 PhaserRecipe lines, cooked; set / add_line / remove_line: one line of an existing phaser preset | create: **used** (must be empty first, cleared with ClearAll at the end); edits: untouched |
| `gma3_store_filter` | one new filter in a free slot | untouched |

## The things to know first

- **A recipe line** is a child of a cue part or a preset (class StandardRecipe; phaser lines are PhaserRecipe). It
  has a selection (usually a group), values (usually a preset), optional MAtricks and filter, Enabled, SelectionMode
  and timing columns. It is addressed as `Sequence S Cue C Part P.L` or `Preset Pool.N.L`.
- **The console cooks by itself.**
  - An `Assign` or property write on a line cooks that line into its target at once (merge low priority).
  - Disabling a line removes its output, and deleting a line re-cooks the rest.
  - **A change of an ingredient (group membership, preset content) is re-cooked into the dependent targets a moment
    later**, in the background: an immediate read still shows the old coverage, and 3 s later it is updated.
    A cue calling an edited **phaser preset** is not guaranteed to follow it: re-cook it (`gma3_edit_phaser_recipe`
    `recook`, below).

  Editing a definition and cooking its output cannot be kept apart on the console. The edit tool therefore reports
  the coverage before and after (`autoCooked`), and the cook tool gives an immediate, verified cook with the option of
  your choice.
- **Cook options and uncooked data** (values stored directly in the same cue or preset):

  | Option | Cooked data | Uncooked data on other fixtures/attributes | Uncooked data on the recipe's own fixture and attribute |
  | --- | --- | --- | --- |
  | `merge_low_priority` | replaced by the recipes' output | kept | **kept** (the recipe does not override it) |
  | `merge` | replaced | kept | **replaced** by the cooked value |
  | `overwrite` | replaced | **deleted** | **deleted** |
  | `remove` | removed | kept | kept |

  A cook without an option opens a pop-up on the console; the tools always send one.
- **Dangling references stay as empty fields.** A deleted group or preset leaves the line with an empty selection or
  values; an empty group cooks nothing. `gma3_recipes` lists these as `problems`.
- The cooked output can include the rest of an activation group: a red preset with R, G, B also cooks W, RY and UV of
  an RGBW fixture.

## First-release capabilities

| Capability | Supported |
| --- | --- |
| Standard lines: group selection, preset values, MAtricks reference, Enabled, Name, SelectionMode | read, add, set, move, remove; coverage predicted and verified |
| Per-line MAtricks columns (XWings, XBlock, XGroup, XWidth, XShift, XShuffle, X, FadeFromX / FadeToX, DelayFromX / DelayToX, PhaseFromX / PhaseToX, SpeedFromX / SpeedToX, and the Y and Z ones) | written by `gma3_store_recipe_cues` and read back there; **not verified on a console** (see below); not edited by `gma3_edit_recipe`. A line whose X, Y or Z column is set (also inherited, `<2>`) gives values to only part of its group: it is read (`axisSelect`) and its coverage is not predicted by `gma3_recipes` and `gma3_cook_recipes` |
| A line's filter (`filter`: a Filter pool number) | written by `gma3_edit_recipe` (add, set; `null` clears) and `gma3_store_recipe_cues`, read back by number; coverage predicted on the filter's attributes for the filter shape described [below](#filters-on-a-line), otherwise not predicted (named) |
| Standard lines with a world, SelectionFromValue | read and kept; not edited; coverage not predicted (named in the result; a merge treats what they reach as possibly replaced) |
| Phaser recipe lines (PhaserRecipe), shapes | read and kept; not created or edited; coverage not predicted (likewise) |
| Targets | presets and cue parts (edit, read); a preset, cue part, cue or whole sequence (cook) |
| Nested recipe presets (a line's preset embeds others) | noted; their own recipes are not re-cooked by this cook |

## `gma3_recipes`

`{target: {preset: "N.M"} | {sequence, cue, part?}}` (part 0 by default). Returns:

- every line (standard and phaser) with:
  - `selection` (group and its `members`), `values` (`preset` "N.M" and name), `matricks`, `filter` (its name) and
    `filterNo`, `filterAttributes` (what the filter passes, when it is modelled), `enabled`, `selectionMode`;
  - the console's last cooking state (`failedCookedPart`, `emptyLastCooking`);
  - `problems`: missing selection, missing or empty group, missing or empty preset, disabled;
  - `axisSelect` when its X / Y / Z column selects part of the group ("X 1");
  - `notPredicted` where coverage is not modelled (phaser lines, a filter of another shape, an axis selection);
- `coverage`: per fixture the attributes the target holds `cooked` (from recipes) and `uncooked` (stored directly);
- `expectedPairs`, the number of fixture/attribute pairs the lines should cook;
- `dependencyNotes`.

## `gma3_edit_recipe`

`{target, action, ...}`:

| action | Parameters | Commands |
| --- | --- | --- |
| `add` | `selection` (group), `values` ("N.M"), `matricks?`, `filter?`, `name?`, `enabled?`, `selection_mode?` (strict/normal) | `Assign Group G At <line n+1>`, (`set Enabled No` when `enabled: false`), `Assign Filter F At <line>`, `Assign Preset N.M At <line>`, `Assign MAtricks M At <line>`, `set` Name / SelectionMode / Enabled |
| `set` | `line` and any of the fields above; `values: null` clears the values, `filter: null` the filter (`set Filter ""`) | the same, on that line |
| `move` | `line`, `to` | `Move <line a> At <line b>`; only upward moves, which land where asked (moving down by k is k moves of the lines below it) |
| `remove` | `line` | `Delete <line> /NoConfirmation` |

Before anything is sent:
- the target and the line exist, and the line is a standard line (move and remove also take phaser lines);
- the referenced group, preset, MAtricks and filter exist (`Assign Filter <missing> At <line>` answers OK and changes
  nothing on 2.5.1.1).

`enabled: false` switches a new line off before it gets values, so it never cooks. The filter is assigned before the
values for the same reason: the line is never cooked unfiltered.

Each `set` reply is compared for its property: Enabled by its truth value, SelectionMode, Name and Values as text (an
unchanged SelectionMode is a failure, not a match). A line list read only in part fails `read_lines` before anything is
sent, and a partial read of the target's data is named in `warnings` (the coverage and `autoCooked` are then partial).
Afterwards the lines are read back and checked:
- add and set: every requested field of the line — selection, values (by the preset's address), MAtricks, filter (by
  number), Enabled, Name, SelectionMode; the other lines unchanged (SelectionMode and filter included);
- move and remove: exactly the expected order.

A failed `Assign` can leave an empty line behind on 2.5.1; the line count catches it. The result carries `linesBefore`,
`linesAfter`, `coverage.before`, `coverage.after` and `autoCooked`.

`values` is the plain string `"4.2"`. A number is refused with that form in the error: as JSON numbers `4.20` and `4.2` are
the same, as presets they are preset 20 and preset 2. A string with quotes inside it (`"\"4.2\""`) is refused the same way.

## `gma3_store_recipe_cues`

`{sequence, mode: "replace" | "append", cues: [{cue, part?, name?, note?, lines: [line, ...]}], cook?, replace_uncooked?,
verify_cook?, preview?, stop_on_failure?, detail?}`. A line is `{selection, values, matricks?, filter?, name?, enabled?,
selection_mode?, x?, y?, z?}` with the fields of `gma3_edit_recipe` add. `x`, `y`, `z` are the line's own MAtricks columns:
the axis settings of [`gma3_configure_matricks`](groups.md#gma3_matricks-and-gma3_configure_matricks) (`wings`, `blocks`,
`groups`, `width`, `shift`, `shuffle`, `fade`, `delay`, `phase`, `speed`, with the same values and units) and `select`, the
X / Y / Z column itself (only the n-th element; with blocks, the n-th block). The #101 build's line options map as
`xblock: 3, x: 2, xwings: 2, xgroup: 4, fade: 16` → `x: {blocks: 3, select: 2, wings: 2, groups: 4, fade: {from: 16, to: 16}}`.

Why a new tool and not a batch form of `gma3_edit_recipe` (`edits: [...]`): a batch item of the edit tool is one line
of one target with its own reference checks, a read-back of every line and the coverage before and after, so 4,300 lines
are 4,300 items and as many full reads. A recipe cue is written as a whole (its lines replaced or appended), the same
groups and presets recur across hundreds of lines, and the build needs the per-line columns, the cue's name and note,
and a cook at the end. This tool checks the references once, writes per cue part and reads back per cue part.

1. Validated as a whole before anything is read: at most 100 cue parts (one sequence), 200 lines per part and 500 lines
   per call (each line is a few requests, so a larger build is several calls); a cue part listed twice, an unknown line
   or axis field, a `values` number and a note with a line break are refused.
2. `read_cues`, once: every cue part exists (the cues are created by `gma3_store_cues`, a part by
   `gma3_store_cue_part`) and its lines are read completely. `replace` is refused on a part that holds phaser lines
   (this tool does not write them back).
3. `check_references`, once for the whole call: every group, preset, MAtricks and filter a line names is in the show (each read
   once, the missing ones listed with the first line that uses them). An empty group is a warning.
4. Each cue part is a batch item, in order, inside one span of the mutation lock (see
   [Batch forms](README.md#batch-forms-su-12)):
   - `replace`: `Delete <part>.<L> /NoConfirmation` for every line, from the last;
   - per line, as `gma3_edit_recipe` adds one: `Assign Group G At <line>`, `set Enabled No` (when `enabled: false`, before
     the values), `Assign Filter F At <line>`, `Assign Preset N.M At <line>`, `Assign MAtricks M At <line>`, `set` SelectionMode, Name, every column
     (`None` for null) and `Enabled Yes`; every `set` reply is checked (a column by the value it reads, as
     `gma3_configure_matricks` checks it);
   - the cue's name on its Part 0, and its `Note` on the cue object;
   - a read-back: the line count, every field written (the preset by its address, the filter by its number), the columns in the display role, the
     lines that were there before unchanged (append), the name and the note (exactly). The item's line has the count and
     only the mismatches.

   A part's steps stop at its first failure; what was sent stays (nothing is undone or retried) and its summary says
   which step stopped it. Other parts go on unless `stop_on_failure: true`; a request without a reply stops the rest
   of the call.
5. `cook` (a `gma3_cook_recipes` mode), only when every part was written and matched: each part is cooked with
   `gma3_cook_recipes` (its inspection, its `replace_uncooked` refusal and, unless `verify_cook: false`, its read-back),
   one after the other. A cook that does not succeed leaves the call `partial`; the parts stay written.

`preview: true` runs steps 1–3 and returns the plan per part (lines before, deletions, lines, requests; `detail: true`
every command and write). No `exclusive`: like `gma3_edit_recipe`, nothing goes through the programmer, the selection
or Preview. Phaser recipe lines (`PhaserRecipe`, e.g. in the Show Start's phaser presets) are out of scope.

## `gma3_cook_recipes`

`{target: {preset} | {sequence, cue?, part?}, mode, replace_uncooked?, preview?, verify?}`.

1. `find_targets`: the presets or cue parts the scope reaches that hold recipe lines (a sequence: every cue part with
   lines, at most 200). For each target:
   - the lines with their members and problems;
   - the coverage before;
   - the predicted cooked coverage: each enabled standard line with a group and a preset gives the group's fixtures
     the preset's attributes, through the fixture's own selective row, the global row of its fixture type, or a
     universal row the fixture has the attribute for (the fixture types are read for each group's members); a line with
     a modelled filter gets only the attributes the filter passes, and the preset's other attributes on its members are
     `excluded`;
   - with merge, the uncooked values it would replace (`replacedUncooked`); with overwrite, the uncooked values it
     would delete (`deletedUncooked`).
   - Unknown coverage never counts as safe. A line that is not predicted (a filter of another shape, phaser line, SelectionFromValue)
     makes every uncooked value on its group's fixtures a possible replacement under merge, marked `(possibly: …)`;
     without a known group (SelectionFromValue, a phaser line without one), every uncooked value of the target.
   - The same holds for a prediction that rests on a failed or incomplete read: a fixture whose attribute list or
     fixture type could not be read, a values preset read only in part (its group's fixtures), and a group with
     unreadable or unread members (every uncooked value of the target). These are named in `warnings`.
2. `check_complete`: the cook is refused, whatever `replace_uncooked` says, when the inspection did not see everything
   the command reaches: more than 200 cue parts with recipes, a sequence or cue whose cues or parts could not all be
   listed, a target whose lines or data were read only in part. The reasons are listed in `incomplete`; cook a smaller
   scope. A preview still returns the plan.
3. `check_uncooked`: merge and overwrite are refused while they would replace or delete uncooked values, unless
   `replace_uncooked: true`. `preview: true` stops before this (it returns the plan either way).
4. `cook`: `Cook <scope> /MergeLowPriority | /Merge | /Overwrite | /Remove`.
5. verify (default): every target is read back; a truncated read-back is a mismatch, never a match.
   - Every predicted fixture and attribute is cooked; under merge low priority, an uncooked value on the same pair is
     accepted.
   - No cooked value is on a fixture no line selects.
   - No cooked value is on an `excluded` pair (an attribute a line's filter keeps out) that no other line gives and no
     unpredicted line may reach: "cooked values a line's filter keeps out".
   - Uncooked values are unchanged on their full content: value, relative value, steps with their layers, phaser
     speed, phase, measure and speed master, fade and delay, and preset references; a missing row is reported as
     disappeared. This holds always under merge low priority and remove, and under merge everywhere except the
     recipes' own pairs and the acknowledged possible replacements; under overwrite they may be gone.
   - Lines that are not predicted are named, and their fixtures are not reported as stray.

## Filters on a line

`Assign Filter F At <line>` (then the console's own cook, or `gma3_cook_recipes`) limits a line to the filter's
attributes. Verified live (below): a line calling a phaser preset keeps the phaser on the filtered attributes only, and
a line calling a RELEASE preset releases only the filtered attributes.

The prediction reads the filter (`Filter F` with asText false: ATTRIBUTES is the list of the attributes it passes, then
its rules `Filter F.1.1.*`) and is made only for the shape verified on the console:
- an attribute mask (HASACTIVEATTRIBUTEFILTER Yes), no dynamic rules, no MAtricks data;
- every layer flag on (ABSOLUTE, RELATIVE, PHASER, TIMING Yes): a filter that drops a layer is not modelled;
- one rule collection with **one** rule: FilterRuleAttributes, or FilterRuleUsedInObject with **APPLYTOFIXTURES No**,
  not inverted. A Used In Object rule with APPLYTOFIXTURES Yes also limits the line to the fixtures of its object.
  Every filter read on the console had one rule; how ATTRIBUTES combines several is not verified, so a filter with
  several rules is not predicted.

Any other filter (or one that cannot be read) leaves the line not predicted, with the reason in `notPredicted`, as
before. A modelled filter that passes none of the preset's attributes is a problem ("the line cooks nothing"). On the
bench show the filters made in the UI from attributes (9001 Dimmer, 9002 Pan + Tilt) and from presets (9003 Tilt,
9004 Pan) all read as modelled.

## `gma3_store_filter`

`{filter, from_preset: "P.N", name?, apply_to_fixtures?, preview?}`. A free slot only (an existing filter is refused:
an Assign onto an existing filter is not modelled), and a preset that holds values.

1. `Assign Preset P.N At Filter F`: the console creates the filter with one Used In Object rule (`Filter F.1.1.1`) on
   the preset, APPLYTOFIXTURES **Yes**. The rule is read and must be that one rule.
2. `set Filter F.1.1.1 APPLYTOFIXTURES No` (or `Yes` with `apply_to_fixtures: true`), the reply compared; then the name.
3. Read back: one Used In Object rule, not inverted, APPLYTOFIXTURES as asked, the name, and the filter's attributes:
   every attribute of the preset must pass (an attribute the preset does not hold is a warning). The result has the
   filter as `readFilter` reads it (attributes, rules, layers, `notPredictable` when a line with it would not be
   predicted).

Nothing is undone after a failure: a filter created before a failed step is kept, and the warnings say so.

## `gma3_edit_phaser_recipe`

No command or property creates a PhaserRecipe line outside the programmer (onPC 2.5.1: `Assign Shape … At <line>` is
an illegal object, `Store … Part P.L` makes a StandardRecipe). The console builds one in **Edit Recipe mode**: the
line is made in the programmer's Part Zero and stored into the target. This tool runs that sequence for a **free
preset slot** (a cue then calls the preset with a standard line, `gma3_store_recipe_cues`).

`action: "create"`, `preset: "P.N"`, `name?`, `exclusive: true`, and one line's fields at the top level or
`lines: [...]` (1-8). A line has `selection` (group), `shape` (default 1), `steps` (exactly 2, see below),
`matricks?`, `speed_bpm?`, `phase?: {from, to}`, `measure?` (beats). A step is `{preset, curve?, trans?, width?}`
for a shape with one value source per step (Sine, Ramp...: the 2 presets from one preset pool, the line's family,
whose attributes come from the step presets), or `{sources, curve?, trans?, width?}` for a shape with several (below). The target may be in **any pool**: the preset's pool does not filter its recipe
lines (verified: a Dimmer + RGBW preset in the Dimmer pool and an RGBW phaser in the Position pool cooked completely).
One family per line is preferred (a cue reads more clearly). A line whose steps come from an All pool (21-25), whose presets may mix families, is allowed with a warning. `preview: true` runs the checks and returns the plan.

**Several value sources per step (Flyout).** A step holds one value source per attribute filter of its shape. Sine and
the other plain shapes have one, without a filter. Flyout (19) and Flyout Inverted (20) have 3 per step: Dimmer
(absolute 100 / 0, Trans 10 %), Tilt (relative; Flyout −11 on step 1, Flyout Inverted on step 2) and Pan (relative
0), with Measure 4. `At Preset` in Edit Recipe mode writes its preset into **every** source of the step: a Dimmer
preset in the Tilt and Pan sources does not cook (`IntegratedPresetMiss`). Such a line is therefore given per source:

```
steps: [{sources: {Dimmer: "1.9020", Tilt: "2.9020"}},
        {sources: {Dimmer: "1.9021", Tilt: {preset: "2.9021", width: 80}}, trans: 40}]
```

A key is the source's attribute (case aside) or its number (`"2"`). A value is a preset, `null` (no preset: the
source outputs its own value, the shape's), or `{preset?, trans?, width?}`. A source not given keeps the shape's
value (`create`, `add_line`) or its own (`set`). The tool reads the shape's value sources first
(`Shape S.1.1.<step>`, ATTRIBUTES) and refuses: one `preset` for a step with several sources, an unknown source, a
source given twice, a preset that holds no value for its source's attribute (it would not cook), and, in `create`,
lines 2+ whose shape has other value sources than line 1's (a copy keeps line 1's value sources: Assign Shape does
not change a line's value sources, a Flyout line re-shaped to Sine keeps its 3). Line 1 is then built in Edit
Recipe mode **without** `Step` / `At Preset` (Group, At Shape, MAtricks, Store), and each source is set after the
ClearAll with `Assign Preset X At Preset P.N.L.1.<step>.<source>`. The result names the sources left to the shape's
value (an absolute Dimmer 100 / 0 of the shape is a fixed value: give it a preset). Verified only for Dimmer, Tilt
and Pan (the Flyout shapes).

**Hard values instead of presets.** A step of a plain shape is `{attribute, absolute? | relative?}`, a value source
`{attribute?, absolute?, relative?, trans?, width?}` (keyed as above). `absolute` is VALUEABSOLUTE in percent (0-100);
`relative` is VALUERELATIVE in **percent of the attribute's whole range** (-100 to 100), not degrees: 20 on a 180°
Tilt is 36°. Verified live (onPC 2.5.1, Rescue, 2026-11-15, 21.9070-21.9072):

- A value source has **one attribute for both steps**: `Assign Attribute "<Attr>" At <line>.1.1.<source>` sets step 2's
  too. The tool sends it once (a command-line `Set` of the attribute is refused; the Lua `set ATTRIBUTES ""` clears it). A source
  the shape filters (Flyout's Dimmer, Tilt, Pan) keeps its filter: another attribute is refused. The attribute must be
  in the show (`ShowData.LivePatch.AttributeDefinitions.Attributes`; an unknown one answers "Illegal object"). On a
  plain shape, an attribute given with a preset filters the preset to that attribute.
- The values are written **from the command line**, `Set <source> Property "ValueAbsolute" "<v>"` (or
  `"ValueRelative"`): the Lua `set` of VALUEABSOLUTE / VALUERELATIVE writes 0. A source keeps its other layer, so the
  layer not given is set to None (`"RawValueAbs" "None"` / `"RawValueRel" "None"`). A preset on the source is cleared
  first (`set PRESET ""`); `Assign Preset` replaces the hard values.
- Without an attribute or a preset the line does not cook: hard values without an attribute are refused. A step may
  give only the attribute: it keeps the shape's value.
- Own values read raw as numbers; a value inherited from the shape reads as text (`<<100.00>100.00>`), one from a
  preset as the preset's name. No command takes a hard value back to the shape's (`RawValueAbs "Default"` reads
  Default; `""` is an illegal value), so `null` on a hard source is refused, and a copy (lines 2+, `add_line`) of a
  line 1 with hard values must give those sources a preset or values. A copy of a hard line 1 given presets gets its
  attribute cleared (back to the shape's filter). `Assign Shape` keeps a line's attribute and its own values.
- The read-back tells cooked values apart by their hard values (cooked as each step's `absolute` / `relative`, as
  float32: -20 reads -19.999998807907; compared to 0.01), checks that the layer not given is absent, and reads each
  source's attribute and values back.

**Trans, width, measure.** `trans` and `width` (percent) are set on the value sources with `set` (TRANSX, WIDTHX),
widths first, after the curves (an explicit `trans` replaces a Snap's TRANS 0). A step's `trans` / `width` applies to
every source of the step that does not set its own. With Link Steps (the default) the 2 widths of a source keep their
sum (Tilt 100 / 80: step 1 set to 90 makes step 2 90; Dimmer 100 / 100: step 1 to 50 makes step 2 150), so a width
is given on one step only and the other takes the rest; both are refused. `measure` is the line's MEASURE (it reads
"4.00"; the cooked measure reads x100). The read-back checks them in the cooked steps.

**Speed master.** `speed_master: n` (1-16) links the line to speed master 3.n: `set Preset P.N.L
SPEEDMASTEROVERRIDE n`, always a number (live 2026-11-14: `0` clears the link; `"None"` reads Speed1, i.e. links
master 1; a name links the wrong master; `""` is ignored), so text is refused before anything is sent; `0` or `null`
clears. The line reads the master's **name** (read from `ShowData.Masters.Speed`, never hard-coded; two masters with
one name, or a master without a name, are warned about: then only the cooked values tell them apart), and the cooked
values carry the master: 0-based in the raw `preset.read` row the tool compares (master 2 reads 1, master 1 reads 0,
absent without a master; `gma3_preset` shows it 1-based, `speedMaster: 2`). Both are checked.
The master **multiplies** the line's Speed X: one cycle = Measure x 60 / (Speed X x master / 60) s (Speed X and master
in BPM), so a line that follows a master has Speed X 60 (one cycle = Measure x 60 / master BPM); a line with a master
and another Speed X is warned about (not an error). A copy (lines 2+, `add_line`) keeps line 1's link, Assign Group /
MAtricks keep it, `set` keeps the line's. A cue line's Speed X still replaces the preset's, and the master multiplies it.

**Adaptive Measure / Width (Chase 7).** The Chase shape has `PLAYBACKADAPTIVEMEASURE` and `PLAYBACKADAPTIVEWIDTH` Yes:
the console sets the measure to the number of phase positions (the fixtures, or the MAtricks positions: 4 fixtures
read 4, with XWings 2 read 2) and step 1's width to 100 / positions (25 / 75, 50 / 50 with XWings 2), and it ignores
MEASURE and WIDTHX meanwhile (they read back unchanged). With a phase spread (0 to 360) that lights one position per
beat, one cycle lasting N beats; without one, all fixtures light together for 1 beat out of N. `adaptive_measure` /
`adaptive_width` (booleans) set the flags. A `measure` switches Adaptive Measure off first (`PLAYBACKADAPTIVEMEASURE No`
before `MEASURE`, only when the line has it or it cannot be read), with a warning: the cycle then lasts `measure`
beats, and the chase keeps its look (one position at a time, from Adaptive Width). A `width` on a line under Adaptive
Width is refused unless `adaptive_width: false` is given (switching it off changes the look: Chase's own widths are
100 / 100, two of four fixtures lit at a time); then `PLAYBACKADAPTIVEWIDTH No` goes before `WIDTHX`. `measure` with
`adaptive_measure: true`, or a width with `adaptive_width: true`, is refused. A flag reads raw as a boolean when the
line sets it itself and as `"<Yes>"` / `"<No>"` when it comes from the shape; a flag the line set itself stays through
Assign Shape, the other follows the new shape. Under Adaptive, the measure and widths the console derives after a new
group, MAtricks or shape, or after a flag changes, are not compared.

**Transform (Mirror) and the line's own MAtricks columns.** `transform: "none" | "mirror"` (PHASERTRANSFORM),
`invert_style: "pan" | "tilt" | "pan_tilt" | "all"` (INVERTSTYLE: Pan, Tilt, P+T, All), `x` / `y: {wings?, blocks?,
groups?}` (XWINGS / XBLOCK / XGROUP and the Y ones; `0` or `null` writes None, which clears the column) and
`phase_y: {from, to}` (PHASEFROMY / PHASETOY; `null` clears both). Phase X stays `phase`. All are written with the
Lua `set` on the line, after the speed and phase X, in the order columns, phase Y, transform, invert style. Each
reply is compared (`"2"`, `"90°"`, `"None"`, `"Mirror"`), and each line reads them back. Verified live (onPC
2.5.1.1, Rescue, 2026-11-15, Group 9001 = 251-254, presets 21.9073 / 21.9074):

- The console only takes the exact names, `"Mirror"` and `"None"`. Any other text (`"mirror"`, `"none"`; for
  INVERTSTYLE `"Dimmer"`, `"Bogus"`) is ignored with `readOk` true and the previous value stays, so the tool sends
  the console name and compares the reply.
- **Mirror sets INVERTSTYLE to Pan** (it was Tilt), and switches XInvW on **only with XWings** (YInvW with YWings).
  With XWings None, Mirror leaves XInvW at No and mirrors nothing: the 4 fixtures cooked alike. XBlock does not
  switch XInvB on. Transform None switches the inverts off. The read-back expects these values: INVERTSTYLE Pan after
  `mirror` (unless `invert_style` is given; it is written after the transform), and XInvW / YInvW Yes when the line
  has the X / Y wings. Mirror without wings gets a warning.
- **Mirror applies at the cook, on the attributes INVERTSTYLE names.** On the second wing (253, 254 with XWings 2) the
  cooked values are hard values with no step preset: absolute 100 − x (step presets 41.67 / 58.33 cooked 58.33 /
  41.67; absolute 30 / 60 cooked 70 / 40) and relative −x (10 / −20 cooked −10 / 20). It is a value mirror, not a
  step swap. A Tilt line under INVERTSTYLE Pan cooked the same on all 4 fixtures; with `invert_style: "tilt"` its
  second wing cooked 70 / 40. The preset's lines keep their step presets and the Transform, and a cue calling the
  preset stays in recipe (`ownNonCookedDataPresent: false`).
- The read-back counts a Mirror line's mirrored values as its own. To be counted, a value must be on a member of the
  line's group (matched by subfixture index; which members form the wing is not predicted) and on an attribute of
  INVERTSTYLE (any attribute for All). It must have no preset in any step, and its hard values must be the mirrored
  ones. When another line's own values match a value, that line keeps it. Evidence that the line cooked (its step
  presets, and old presets left after an edit) still comes only from the unmirrored wing. Mirror is detected from the
  line as read, before and after the edit, so a line mirrored through a MAtricks object (21.9056) is read the same
  way.
- A line with a MAtricks object (`matricks`) reads its columns and Transform from that object (21.9056 / 21.9058 read
  XWings 2 and Mirror from MAtricks 9008). Whether a write on such a line reaches the shared object is not known, so
  Transform, the columns and `invert_style` are refused on a line that has or gets a MAtricks. Set the columns on the
  object with `gma3_configure_matricks`, or give the line its own columns without a MAtricks (that tool has no
  Transform setting). A new MAtricks on a line in `set` drops those fields from the comparison.
- A copy (lines 2+ in `create`, `add_line`) keeps line 1's Transform, invert style and columns unless it gives its
  own. A copy of a Mirror line 1 is noted in the warnings (give `transform: "none"`). A change of wings, blocks or
  groups moves the phase positions, so under Adaptive Measure / Width the derived measure and widths are not
  compared.

**Several lines.** A step holds one value source per attribute filter: a second `At Preset` on the same step replaces the first, and a
second `At Shape` on the same group re-shapes the line instead of adding one. Line 1 is therefore built in Edit Recipe
mode, and lines 2+ are copies of it: `Copy Preset P.N.1 At Preset P.N.k /NoConfirmation`, then `Assign Group / Shape /
MAtricks n At Preset P.N.k` where they differ and `Assign Preset X At Preset P.N.k.1.<step>.<source>` for the steps.
A source line k gives no preset loses line 1's (`set PRESET ""`: the source gets back its own value). A copied line
keeps line 1's speed, phase and measure unless it sets its own (they are written before the copies); line 1's curves,
trans and widths are written after the copies, so a copy starts from the shape's. A cue calls the preset with one standard line, and every
line cooks into it at its own speed. A Speed X on that cue line replaces the speed of every line.

**Curves.** `curve` is one of `linear`, `ease_in`, `ease_out`, `ease_in_out`, `swing`, `snap`, or `reset` (back to
the shape's curve). It is sent from the command line,
`Set Preset P.N.L.1.<step>.<source> Property "Curve" "<Linear|Ease In|Ease Out|Ease In and Out|Swing|Snap|Reset>"`,
on every value source of the step.
The Lua `set` of CURVE is ignored, and CURVE reads back as an opaque id. With Link Steps (the default), a step's curve
writes its own DECEL and the next step's ACCEL:

| Curve | Own DECEL | Next step's ACCEL |
| --- | --- | --- |
| Linear | 0 | 0 |
| Ease In | +100 | −100 |
| Ease Out | −100 | +100 |
| Ease In and Out | −100 | −100 |
| Swing | +100 | +100 |
| Snap | 0 (and TRANS 0) | 0 |

A named curve also writes the step's TRANS: 0 for Snap, **100 for the others** (verified live: Flyout's Dimmer Trans
10 % became 100 % with Linear). A `trans` given on the step is written after the curve and stays. The read-back
checks those values in the cooked steps.

1. Checks, nothing sent otherwise: the slot is free; group, shape, step presets and MAtricks exist; the mode is off,
   Part Zero empty, no dialog open (`recipe.editState`); the programmer read completely and empty; RecipeStoreMode
   is Normal.
2. `Store Preset P.N /NoConfirmation` with the empty programmer: creates the preset and **clears the pending Edit
   Recipe target**. A store made in Edit Recipe mode leaves its target pending, and the next `EditRecipe <other
   target>` opens "Update last object?" (OK overwrites that pending target with the programmer; an empty programmer
   wipes its recipe lines). A normal store just before prevents the dialog (verified live).
3. `recipe.editBegin` queues `EditRecipe Preset P.N` with CmdIndirect: sent with Cmd() from the plugin thread, the
   dialog would stall the bridge. The server polls `recipe.editState` until the mode reads on. If "Update last
   object?" opens anyway, it is answered **Cancel** (never OK) with `dialog.press` and the call stops.
4. Line 1: `Group`, `At Shape` (the line appears in Part Zero, checked), `Step 1`, `At Preset`, `Step 2`, `At Preset`
   (only for one preset per step), `MAtricks`, one command at a time; Part Zero is checked again (exactly one PhaserRecipe line), then
   `Store Preset P.N /Merge /NoConfirmation` (Part Zero empties).
5. `recipe.editEnd` queues the `EditRecipe` toggle (only while the mode reads on); the mode is read back off.
6. `ClearAll`: after the mode is off the programmer still holds the phaser's values, **output on stage from
   `At Shape` until here**. The programmer and Part Zero are read back empty.
7. The name; line 1's value sources (given per source); lines 2+ (copy and assigns, cleared sources, the line count
   checked after each copy); `SPEEDX` / `PHASEFROMX` / `PHASETOX` / `MEASURE` per line (replies compared as
   numbers; the adaptive flags before `MEASURE`, `SPEEDMASTEROVERRIDE` last, read back by the master's name); the curves of every line, **after all the copies** (a copy keeps line 1's custom curves); `WIDTHX` then
   `TRANSX` per source; `Cook Preset P.N /MergeLowPriority`.
8. Read back:
   - the line count, and each line a PhaserRecipe with its group and MAtricks and no failed cook;
   - every value cooked and integrating, in order, the 2 step presets of one value source (on that source's
     attribute; "none" for a source left to the shape's value), each source with a preset has at least one value,
     the line's cook state is not failed, and nothing is uncooked;
   - the cooked speed of each line's values is its `speed_bpm` / 60 Hz, its measure x100 is `measure` (the phase is
     spread per fixture by the MAtricks: only its set reply is compared), each curve's DECEL / ACCEL / TRANS, and the
     trans and widths asked (the other step's width: the shape's sum minus the one given) in the cooked steps;
   - each line's adaptive flags and speed master (by name) as written or copied from line 1, and the cooked
     `speedMaster` of its values;
   - the mode off, Part Zero and the programmer empty.

A failure before the store switches the mode off, clears the programmer and deletes the preset the call created (its
slot was free). After the store the preset is kept and the failure reported.

Two console facts for whoever works next to this tool (verified live):
- **After a successful build the preset stays the pending Edit Recipe target.** A manual `EditRecipe <other target>`
  at the console then opens "Update last object?". OK would overwrite that preset with the programmer. The tool's
  own next call is safe, because its empty store comes first.
- **An empty `Store Preset P.N /NoConfirmation` on an existing phaser preset wipes its recipe line.** That is why
  the tool only stores into a free slot, and refuses an existing one.

Speed: a cue line's Speed X **replaces** the preset's (RELATIVESPEED No); an empty column (`SPEEDFROMX` None) follows
the preset. 60 BPM = 1 Hz.

### Editing an existing phaser preset: `set`, `add_line`, `remove_line`

No programmer and no Edit Recipe mode (no `exclusive`): every change is an `Assign`, `Set`, `Copy` or `Delete` on the
preset's lines, then `Cook Preset P.N /MergeLowPriority`.

- `set` changes line `line` (default 1): `selection`, `shape`, `matricks`, `speed_bpm`, `phase`, `measure`,
  `speed_master`, `adaptive_measure`, `adaptive_width`, `transform`, `invert_style`, `x`, `y`, `phase_y`, `name`,
  and `steps: [{preset? | sources?, curve?, trans?, width?}, ...]` (`{}` keeps a step; in `sources` a source not
  given is kept and `null` clears its preset with `set PRESET ""`, back to the shape's value). A new shape must have
  the line's value sources (Flyout and Flyout Inverted do). The line must be a PhaserRecipe of 2 steps whose values
  can be told apart by their value sources' presets (a plain shape: each step from a preset).
- `add_line` appends a copy of line 1 (`Copy Preset P.N.1 At Preset P.N.k`), retargeted with the given fields:
  `selection` and the steps (a preset or sources each) are required; shape, MAtricks, speed, phase and measure are
  line 1's unless given. Every step is reset to the shape's curve, then given its `curve` if any (a copy keeps line
  1's custom curves). A source given no preset loses line 1's.
- `remove_line` deletes line `line` (`Delete Preset P.N.L /NoConfirmation`). The later lines move up (3 lines,
  delete line 2: line 3 becomes line 2). The only line is never removed: delete the preset instead.

Sent in this order: `Assign Group | Shape | MAtricks n At Preset P.N.L` (only what changes),
`Assign Preset X At Preset P.N.L.1.<step>.<source>` (the step keeps its curve), `set PRESET ""` on a cleared source,
the curves on every source of the step (a step given a curve is reset to the shape's first, then the named curve, so
a Linear over a Snap gets TRANS 100 back); the adaptive flags are written after the Assigns and before the curves, `WIDTHX` then `TRANSX`, `SPEEDX` / `PHASEFROMX` / `PHASETOX` / `MEASURE` / `SPEEDMASTEROVERRIDE`,
the name, then the Cook. A failed command stops the edit; a failed setting is reported and the rest is sent. **A new shape recomputes the curves of the steps that have no custom curve; a
custom curve stays** (`curve: "reset"` takes it back to the shape's).

Checked first, nothing sent otherwise: the preset and the line exist; each value source's 2 presets come from one
preset pool, hold the source's attribute and are not the preset itself; no other line has the same 2 step presets on
the same attribute (a source left to the shape's value on two lines is allowed: its values are only checked where
one line alone can have made them); group, shape, MAtricks and step presets exist; no dialog is open; the Edit Recipe
mode is off.

Read back:
- every line as expected: group, MAtricks, shape, speed (SPEEDX raw, in Hz), phase, measure, cook state, each value
  source's preset, and its ACCEL / DECEL / TRANS / WIDTH where they are known. After a new shape or a reset they are
  the shape's and are not compared; after a width the other step's is the sum minus it, and the trans of that source
  is not compared unless given;
- the edited line's cooked values come from its 2 step presets at its speed, and no value is left from its old step
  presets;
- every other cooked value unchanged, and nothing uncooked added. A fixture and attribute that the edited line
  outputs, before or after, is left out of that comparison: where two lines act on the same attribute of the same
  fixture, the later line's value wins, so another line's value may rightly appear or go.

`add_line` and `remove_line` also need the line (line 1 for `add_line`) to be 2 steps from presets: the read-back
tells cooked values apart by their step presets.

### Re-cooking the calling cues: `recook`

A cue that calls the preset with a standard line is **not guaranteed to follow the edit**. The THK migration bench
(2026-11-15) saw a cue keep the old width and trans, and once the old speed, until it was re-cooked (Off then Goto was
not enough). Other runs saw the cue follow at once: Sequence 9000 Cue 11 on 21.9005 (a speed, a new family, a step
retarget, a removed line), and Sequence 9031 Cue 1 on 21.9075 (a width and a trans, in the cue's cooked data and in
the output, even after a bare `Set ... Property "TRANSX"` with no Cook). The cause of the difference is not known, so
the rule is to re-cook the calling cues after every change of a phaser preset.

`recook: true` (every sequence) or `recook: {sequences: [...], mode: "merge_low_priority" | "merge"}` on `set`,
`add_line` and `remove_line` (refused on `create`: a new preset has no caller):

- Only after the preset's own edit cooked and read back matched; otherwise the callers are listed under `skipped`
  with the reason, and nothing is cooked.
- Callers: `gma3_preset_usage`'s scan (`presetUsage` with a sink, executors not scanned), over `sequences` or every
  sequence, within 1000 cues and 120 s. An incomplete scan is reported (`recook.complete: false`, the reasons, a
  warning). Not searched: presets that embed the preset, CueZero, OffCue. Give `sequences` on a large show.
- Each cue part with a recipe line calling the preset is cooked with `gma3_cook_recipes` (its own inspection,
  refusal of a merge over uncooked values, coverage read-back), **one part at a time**, never the whole cue: a
  cue-wide MergeLowPriority cook empties part 0 where another part holds the same attributes (bench 2026-11-15). A
  part whose values reference the preset with no recipe line calling it (stored values, or cooked from another preset
  that calls it) is skipped with that reason.
- Read back per cue: every cooked value of the part that references the preset (`absPreset` / `relPreset`) matches
  the preset's value for the same fixture and attribute (step count, each step's preset, absolute / relative, accel,
  decel, trans, width; phase, measure, speed master; speed unless the cue line has its own Speed X, `SPEEDFROMX` not
  None, then warned); none is left where the preset no longer outputs; `OwnNonCookedDataPresent` No (Yes before and
  after is a warning, not a mismatch); the cue's other parts unchanged. A problem makes the call's verification
  `mismatched`; a failed cook makes it `partial`.
- `recook` in the result: `recooked` (part, outcome, verification, values compared, OwnNonCookedDataPresent) and
  `skipped` (part, reason). With `preview: true` the scan runs and `recook.wouldRecook` lists the parts.

Without `recook`, the call warns that the calling cues were not re-cooked, with the console's reference count
(`referencedBy`) and no scan (a scan reads every cue). No warning when the count is 0.

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/recipes.live.ts`, 1/1, 5.4 s):
  - two lines on a cue part next to an unrelated stored Dimmer value;
  - SelectionMode set to Normal and back to Strict, each verified by its reply and the read-back;
  - a group change cooked to the new members with the unrelated value kept;
  - overwrite refused;
  - lines moved and removed;
  - an empty group and a deleted preset reported;
  - a preset recipe added and cooked.
- Not verified on a console (`gma3_store_recipe_cues`, #101; no live run for this change): writing the per-line
  MAtricks columns with `set` and reading them back in the display role. The #101 build set `FadeFromX`, `FadeToX`,
  `XBlock`, `X`, `XWings` and `XGroup` on new lines from Lua and checked only the line count; the probe record lists
  "the full MAtricks property set" on a line, and MAtricks objects accept these properties and values (SB-02). How a
  column reads while a MAtricks reference supplies it (`<2>`, inherited) and whether `None` clears an override are
  not known. Cue names on Part 0 and `set` on lines are verified (SU-06, SB-05); the cue's `Note` is not.
- Not covered:
  - the background cook's exact timing (observed: not yet on an immediate read, done after 3 s);
  - phaser recipe lines other than `gma3_edit_phaser_recipe`'s (more than 2 steps, a cue part as the target, a value
    source's 2 steps from different pools); a step from a preset and the other from hard values on one source (allowed,
    not run on a console);
  - value sources on attributes other than Dimmer, Tilt and Pan (shapes other than Flyout 19 / 20 with several
    sources); per-source curves (a curve applies to every source of its step);
  - worlds; filters of another shape than the one modelled (attribute rules and Used In Object rules with
    APPLYTOFIXTURES No, one rule, every layer on) — they stay not predicted;
  - recipe templates;
  - the Edit Recipe mode outside `gma3_edit_phaser_recipe`.
- Verified live for `gma3_edit_phaser_recipe` (onPC 2.5.1, bridge 0.52.0, 2026-11-14): a Dimmer phaser (8 fixtures,
  8/8 cooked, 2 Hz) and a colour phaser (4 fixtures, RGBW, 16/16 cooked, 0.5 Hz), built back to back, without a
  dialog; then a Dimmer line (Snap) and an RGBW line (Ease In) in the All preset 21.9002 (20/20 cooked, 2 Hz and
  0.5 Hz, curves read back), called by one standard line of a cue (20 cooked values). The tool's Cancel and abort branches ran only against the fake bridge (`test/phaser-recipes.test.ts`).
  The console facts behind them were probed by hand through the same bridge ops and `gma3_dialog`:
  - The bridge stays responsive while "Update last object?" is open, and Cancel leaves the pending preset intact.
  - An aborted build (mode off after `At Shape`, then ClearAll) leaves the target and the programmer empty.
- Verified live for the edit actions (bridge 0.52.1, 2026-11-14, scratch preset 21.9005 called by Sequence 9000
  Cue 11), each read back matched:
  - `set` of step presets, Swing and 45 BPM;
  - a new shape with a reset;
  - Snap, then Linear (TRANS back to 100);
  - phase and name;
  - `add_line` twice (Ease In at 90 BPM, Swing at 30 BPM);
  - `remove_line` of a middle line;
  - a duplicate step pair and a missing line, refused.
- Verified live for several value sources per step (onPC 2.5.1.1, bridge 0.52.1, show "Rescue", 2026-11-14, Group
  9002 of 12 spots, scratch preset 21.9025, the code run directly against the bridge):
  - `create` on Flyout (19) with `sources` Dimmer 1.9020 / 1.9021 and Tilt 2.9020 / 2.9021 (relative), Pan left to
    the shape: built without "Update last object?", 36 / 36 cooked, cook state None, Pan cooked from the shape
    (relative 0, no preset), 34 BPM and Measure 4 read back;
  - `set`: Pan given 2.9020 / 2.9021 then cleared with `null` (back to the shape's value), Dimmer step 1 Trans 20
    then 10, Tilt step 2 Width 70 (step 1 went to 110) then 80, Measure 2, 4 and 1, each read back matched;
  - `add_line` on Group 9001 (Dimmer 1.9010 / 1.9011, Tilt 2.9000 / 2.9001) and `remove_line`, matched;
  - `create` with 2 lines in 21.9026: Flyout on Group 9002 with Linear on step 1, Trans 30 on step 2 and Tilt
    Width 70 on step 2 (step 1 read 110), then a copy on Flyout Inverted for Group 9001: 48 / 48 cooked, matched; the
    copy kept line 1's Measure 1 and the shape's Trans / Width;
  - one preset per step on Flyout, refused before anything was sent; the old form (Sine, one preset per step, Snap,
    Measure 1) still matched (12 / 12);
  - the output on spot 101 (`Group 9002 At Preset 21.9025` in the programmer, then ClearAll): at 34 BPM and Measure
    4 a cycle lasts about 7 s (Dimmer 100 for about 3.5 s, then 0; Tilt down then up; Pan still); at Measure 1 the
    Dimmer rose every 1.76 s on average (one beat at 34 BPM is 1.765 s).
  - An absolute Tilt preset (2.9000) in the relative Tilt source of Flyout cooked the preset's absolute value plus the
    shape's relative value (−11 / 0): the Flyout's Tilt source is meant for relative presets.

- Verified live for the speed master and the adaptive flags (onPC 2.5.1.1, bridge 0.52.1, show "Rescue",
  2026-11-14, Group 9001 of 4 Daytona washes, output read on universe 7, every read back matched):
  - `create` 21.9030 with 2 Snap lines, Dimmer 1.9010 / 1.9011 on master 2 and Position 2.9000 / 2.9001 on master 3
    (Speed X 60, Measure 1): lines read "PAN" and "TILT", cooked `speedMaster` 1 and 2. Output on fixture 251 (the
    preset in the programmer): 3.2 at 15 BPM and 3.3 at 30 BPM gave a Dimmer period of 4.02 s (4.0 expected) and a
    Tilt period of 2.02 s (2.0); 3.3 to 60 BPM gave Tilt 0.99 s (1.0), the Dimmer unchanged (3.97 s);
  - `add_line` without `speed_master`: the copy kept line 1's master ("PAN", cooked 1); `set` to master 1 (reads
    "Speed1", cooked 0), to `null` and to `0` (reads "", nothing cooked), to 2; `"2"`, `"PAN"`, `"None"` and 17 refused
    before anything was sent; Speed X 34 with a master warned;
  - `create` 21.9029 on Chase with phase 0 to 360, 15 BPM and Measure 1: Adaptive Measure switched off, Measure 1 read
    back, warned (it ended `partial` before, with Measure read 12); output: fixture 251 rose every 3.98 s (4.0 s
    expected), each fixture lit about 1 s in turn;
  - `set` on Chase lines: `adaptive_measure: true` (measure back to 4), `measure 2` (flag switched off first), a width
    without `adaptive_width: false` refused, with it 50 / 150, `adaptive_width: true` (25 / 75 again), MAtricks 9000
    under Adaptive Measure (measure 2, widths 50 / 50, not flagged).

  The cue's own values followed every change. The new order of `create` (curves after the copies) was verified live
  too: 21.9006, a Dimmer line with Snap on step 1 and an RGBW line without a curve, matched; line 2 kept the Sine
  curve (TRANS 100) instead of line 1's Snap. A copy keeps line 1's Snap, and `Assign Preset` keeps it too.

- Verified live for hard values (onPC 2.5.1.1, bridge 0.52.1, show "Rescue", 2026-11-15, Group 9001 of 4 Daytona,
  the code run directly against the bridge), each read back matched:
  - `create` 21.9071: Sine, Tilt relative -20 / 20 at 30 BPM, built without At Preset in the mode (4 / 4 cooked);
  - `create` 21.9072 with 2 lines: Dimmer 1.9010 / 1.9011, then a copy turned into Pan absolute 30 / 70 (8 / 8);
  - `set`: Tilt relative to -30 / 30 and 40 BPM; Pan absolute to relative -10 / 10; the Dimmer preset line to Dimmer
    absolute 10 / 90; `add_line` of a preset line behind the hard Tilt line (attribute cleared);
  - refused before anything was sent: no attribute, an unknown attribute, another attribute on a Flyout source,
    `null` on a hard source;
  - Sequence 9028 Cue 1 calling 21.9072 with one standard line, cooked merge low priority: `ownNonCookedDataPresent:
    false`, 8 / 8 cooked; output on fixture 251: Dimmer 10.3 % to 89.9 %, Pan 50 % ±10.0 % (10 % of the whole range).

- Verified live for Transform and the line's own columns (onPC 2.5.1.1, bridge 0.52.1, show "Rescue", 2026-11-15,
  Group 9001 of 4 Daytona, the code run directly against the bridge), each read back matched:
  - `create` 21.9074 with 2 lines: Pan 2.9042 / 2.9043 at 40 BPM with `transform: "mirror"`, `x: {wings: 2}`, then a
    Tilt line (absolute 35 / 65, phase 90, 30 BPM) with `transform: "none"`. Read back: line 1 Mirror, INVERTSTYLE
    Pan, XInvW Yes, XWings 2; line 2 None, XInvW No, XWings 2 (kept from the copy). 8 / 8 cooked: 251 / 252 Pan
    integrate 2.9042 / 2.9043, 253 / 254 Pan cook 58.33 / 41.67 without a preset, Tilt the same on all 4. No stray
    value is reported;
  - `set` of `speed_bpm` 20 on line 1: matched, with no "values of the other lines changed". The old code reported
    "4 value(s) of the other lines changed (first: 253 Pan ...)" on the same kind of line (probe preset 21.9073);
  - on 21.9073 (a Tilt hard-value line): `set` with `transform: "mirror"` and `x: {wings: 2}` left Tilt unmirrored
    (INVERTSTYLE Pan); `invert_style: "tilt"` then mirrored 253 / 254 (70 / 40). Both matched;
  - Sequence 9029 Cue 1 calling 21.9074 with one standard line, cooked merge low priority: `ownNonCookedDataPresent:
    false`, 8 / 8 cooked. Output while it played (16-bit Pan, sampled every 0.5 s for 6 s): Pan on 251 and 253 moved
    in opposite directions. At 2.1 s 251 was at its maximum (38090) and 253 at its minimum (27612), and at 5.0 s the
    reverse (27322 / 38131); the two sum to about 65,500 throughout. Tilt was the same on both.
  - more `set`s on 21.9073, each matched: `transform: "mirror"` on a line already Mirror (INVERTSTYLE Tilt went
    back to Pan, as expected); `transform: "none"` with style Tilt (inverts off, style kept at Tilt); a new shape
    (Sine to Linear) and a new group (9002 and back) on a Mirror line with style Tilt (the console kept Transform,
    style, XWings and XInvW).
  - Not run on a console: `y` columns and `phase_y` beyond the write and read-back (Group 9001 is one row; phase Y on
    grids is the migration bench's 5th series), the `pan_tilt` and `all` styles in the output, Mirror with blocks or
    groups, on an odd group or with wings other than 2, a line mirrored through a MAtricks object edited by the tool
    (21.9056 was read, not edited), and `add_line` behind a Mirror line 1 (fake bridge only).

- Verified live for filters (onPC 2.5.1.1, show "Rescue", 2026-11-15, Group 9001 = Daytona 251-254, the code run
  directly against the bridge):
  - by hand first: `Assign Preset 2.9041 At Filter 9005` created a FilterRuleUsedInObject rule with APPLYTOFIXTURES Yes;
    `set APPLYTOFIXTURES No` replied "No"; ATTRIBUTES read as `[Pan]`. On a line, `Assign Filter 9005` set it, `set
    Filter ""` cleared it (the line re-cooked at once: 72 RELEASE values instead of 4), and `Assign Filter 9999` (no
    such filter) answered OK and changed nothing;
  - `gma3_store_filter` 9006 from 2.9041 with a name: matched (one Used In Object rule on 2.9041, APPLYTOFIXTURES No,
    attributes `[Pan]`); `readFilter` reads 9001-9006 as modelled;
  - `gma3_store_recipe_cues` Sequence 9030, replace, cook merge low priority, all matched: Cue 1 = Group 9001 1.9010
    (Dimmer 100), then Group 9001 21.9072 (Dimmer absolute 10 / 90 + Pan relative -10 / 10 phaser) with filter 9006:
    predicted 8 pairs (line 2: Pan only), 8 cooked. Read back: Dimmer from 1.9010 (1 step), Pan with 2 steps (-10 /
    10) from 21.9072, no Dimmer from the phaser. Cue 2 = Group 9001 21.9046 (RELEASE of 18 attributes) with filter 9006:
    predicted and cooked 4 values, Pan Release only. Both parts read `ownNonCookedDataPresent: false`;
  - output on 251 and 253 (16-bit, every 0.5 s for 7 s) after Go: Pan moved 26257 to 39302 (±10 % of the range around
    the centre), Dimmer stayed 65535 (line 1's 100 %, not the phaser's 10 / 90). After Go cue 2: Dimmer still 65535
    (not released), and Pan kept moving: a RELEASE does not stop a relative phaser (THK migration bench, series 1),
    so the released Pan is seen in the cooked data, not in the output. Sequence 9030 was switched off;
  - `gma3_edit_recipe set` line 2 `filter: null` then `filter: 9006`, both matched; the console re-cooked at once each
    time (Dimmer came from 21.9072, 2 steps, then from 1.9010 again); `gma3_cook_recipes` of the sequence matched (8 + 4).
- Verified live for `recook` (onPC 2.5.1.1, bridge 0.52.1, show "Rescue", 2026-11-15, Group 9001 = Daytona
  251-254, the code run directly against the bridge):
  - `create` 21.9075 "TEST I4 RECOOK" (Sine, 6 BPM, Measure 1) first with 1.9031 / 1.9032: mismatched as it should
    be (those presets hold no value for 251-254, line 1 failed to cook); `set` to 1.9010 / 1.9011: matched, 4 / 4
    cooked, no re-cook warning (`referencedBy` 0);
  - Sequence 9031 Cue 1 = Group 9001 + 21.9075 (`gma3_store_recipe_cues`, cooked merge low priority):
    `ownNonCookedDataPresent: false`; output on 251 (every 250 ms for 12 s) a 10 s sine, 5 s up, 5 s down;
  - `set` step 1 `width: 160` without `recook`: matched, with the warning (2 objects reference the preset). The bench
    finding was **not** reproduced: 13 s later the cue's cooked values read width 160 / 40 and the output was the
    160 / 40 shape (about 2 s down, the rest up). `set` step 2 `trans: 50`: the cue read trans 50 at once; a bare
    `Set Preset 21.9075.1.1.2.1 Property "TRANSX" "100"` (no Cook) reached the cue at once too;
  - `set` step 1 `width: 120`, step 2 `trans: 50`, `recook: {sequences: [9031]}`: matched. Steps: Cook of the preset,
    `find_callers` (complete), `Cook Sequence 9031 Cue 1 Part 0 /MergeLowPriority`, read-back: 4 values compared
    (width 120 / 80, trans 100 / 50, presets 1.9010 / 1.9011, speed 0.1 Hz), `ownNonCookedDataPresent: false`.
    Output on 251 (14 s): about 6 s up, 2 s down, 2 s at 0. Sequence 9031 was switched off;
  - not run on a console: a cue that really kept old values (so a re-cook that changes them), `mode: "merge"`, a
    skipped part, a cue line with its own Speed X, several parts in one cue, an incomplete scan (fake bridge only,
    `test/phaser-recipes.test.ts`).
- Not run on a console for filters: the "keeps out" mismatch (fake bridge only: the console always applied the filter);
  a filter on a line in a preset; a filter on a colour preset where the rest of the activation group might cook too
  (the check would report it as kept out); filters with several rules, a layer off, inverted rules or APPLYTOFIXTURES
  Yes (left not predicted). The cook check is per fixture and attribute, not per line: in Cue 1 above, a filter that the console
  ignored would still have read back matched, because line 1 also predicts the Dimmer pair.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/recipes.live.ts` on a disposable show with an empty programmer and
bridge 0.24.0. It uses Sequence 906, Groups 910–911, Presets 23.931 and 4.931, the fixtures 401–404
(`GMA3_LIVE_RECIPE_FIXTURES`) and the presets 4.4 and 1.11 (`GMA3_LIVE_RECIPE_COLOR`, `_DIMMER`), refuses to run when
those objects exist, and deletes them at the end.
