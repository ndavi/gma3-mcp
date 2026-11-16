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
  attributes);
- `gma3_store_generator` creates or edits a Random generator, for a preset line's `generator` (the line then cooks
  the generator in place of a values preset).

Recipe definitions are read and written with the existing object ops (`children`, `objects`, `set`) and `Assign` /
`Move` / `Delete` / `Cook` commands. The cooked state of a target comes from `preset.read`, which bridge **0.24.0**
extends to cue parts (see [the bridge protocol](../reference.md#cue-part-data-plugin-v0240-sb-05)). Evidence:
[the SB-05 probe record](../probes/sb-05-recipes-macos-2.5.1.md).

| Tool | Changes | Programmer |
| --- | --- | --- |
| `gma3_recipes` | nothing (read-only) | untouched |
| `gma3_edit_recipe` | one recipe line of a preset or cue part; **the console cooks the edited line at once** | untouched |
| `gma3_store_recipe_cues` | the recipe lines of up to 100 cue parts of one sequence, their cue names and notes, a part's PhaserSync and the cue's appearance; each written line is cooked at once, as above | untouched |
| `gma3_cook_recipes` | the cooked (and, with merge or overwrite, the uncooked) data of the affected targets | untouched |
| `gma3_edit_phaser_recipe` | create: one preset with 1-8 PhaserRecipe lines, cooked; set / add_line / remove_line: one line of an existing phaser preset | create: **used** (must be empty first, cleared with ClearAll at the end); edits: untouched |
| `gma3_store_filter` | one new filter in a free slot | untouched |
| `gma3_store_generator` | create: one new generator in a free slot; edit: channels of an existing one | create, or a new channel: **must be empty** (checked, never cleared); settings only: untouched |

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
  the coverage before and after and whether the cooked values changed (`autoCooked`), and the cook tool gives an immediate, verified cook with the option of
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
| Per-line MAtricks columns (XWings, XBlock, XGroup, XWidth, XShift, XShuffle, X, FadeFromX / FadeToX, DelayFromX / DelayToX, PhaseFromX / PhaseToX, SpeedFromX / SpeedToX, and the Y and Z ones) | written by `gma3_store_recipe_cues` and read back there; not edited by `gma3_edit_recipe` (a phaser line's X / Y wings, blocks, groups and phase Y: `gma3_edit_phaser_recipe`). A line whose X column is set gives values to only part of its group: the coverage is predicted on the fixtures that select keeps ([below](#matricks-select-on-a-line)), from the line's own columns or from its MAtricks object, and left not predicted (named) where the rule is not verified |
| A line's filter (`filter`: a Filter pool number) | written by `gma3_edit_recipe` (add, set; `null` clears) and `gma3_store_recipe_cues`, read back by number; coverage predicted on the filter's attributes for the filter shape described [below](#filters-on-a-line), otherwise not predicted (named) |
| A preset line's generator (`generator`: a Generator pool number, in place of the values) | written by `gma3_edit_recipe` (add, set; `null` clears) on preset lines only, read back by number; coverage predicted on the generator's channel attributes ([below](#generators-on-a-preset-line)); not written by `gma3_store_recipe_cues` |
| Standard lines with a world, SelectionFromValue | read and kept; not edited; coverage not predicted (named in the result; a merge treats what they reach as possibly replaced) |
| Phaser recipe lines (PhaserRecipe), shapes | created in a free preset slot and edited (line settings, add or remove a line) by [`gma3_edit_phaser_recipe`](#gma3_edit_phaser_recipe), which reads its own lines back; read and kept by the other tools, not created or changed by them (`gma3_edit_recipe` can move or remove one); coverage not predicted by them (likewise) |
| Targets | presets and cue parts (edit, read); a preset, cue part, cue or whole sequence (cook) |
| Nested recipe presets (a line's preset embeds others) | noted; their own recipes are not re-cooked by this cook |

## `gma3_recipes`

`{target: {preset: "N.M"} | {sequence, cue, part?}}` (part 0 by default). Returns:

- every line (standard and phaser) with:
  - `selection` (group and its `members`), `values` (`preset` "N.M" and name), `matricks`, `filter` (its name) and
    `filterNo`, `filterAttributes` (what the filter passes, when it is modelled), `generator` (`{no, name}`) and
    `generatorAttributes` (one per channel), `enabled`, `selectionMode`;
  - the console's last cooking state (`failedCookedPart`, `emptyLastCooking`);
  - `problems`: missing selection, missing or empty group, missing or empty preset, disabled;
  - `axisSelect` when its own X / Y / Z column is set ("X 1");
  - `selected` (the fixtures the MAtricks select keeps, in selection order) and `matricksSelect` (the select and where
    it comes from: `X 1, XGroup 2 (MAtricks 9009 "...")`), when an X select keeps part of the group;
  - `notPredicted` where coverage is not modelled (phaser lines, a filter of another shape, a MAtricks select outside
    the verified rules);
  - `phaseNote` when a MAtricks select meets a phase spread ([below](#phase-and-a-matricks-select)): what the console
    does with the phase, and the phases the kept fixtures get when they are predicted;
- `coverage`: per fixture the attributes the target holds `cooked` (from recipes) and `uncooked` (stored directly);
- `expectedPairs`, the number of fixture/attribute pairs the lines should cook;
- `dependencyNotes`.

## `gma3_edit_recipe`

`{target, action, ...}`:

| action | Parameters | Commands |
| --- | --- | --- |
| `add` | `selection` (group), `values` ("N.M") or `generator` (preset lines), `matricks?`, `filter?`, `name?`, `enabled?`, `selection_mode?` (strict/normal) | `Assign Group G At <line n+1>`, (`set Enabled No` when `enabled: false`), `Assign Filter F At <line>`, `Assign Preset N.M At <line>`, `Assign Generator N At <line>`, `Assign MAtricks M At <line>`, `set` Name / SelectionMode / Enabled |
| `set` | `line` and any of the fields above; `values: null` clears the values, `filter: null` the filter (`set Filter ""`), `generator: null` the generator (`set Generator ""`) | the same, on that line |
| `move` | `line`, `to` | `Move <line a> At <line b>`; only upward moves, which land where asked (moving down by k is k moves of the lines below it) |
| `remove` | `line` | `Delete <line> /NoConfirmation` |

Before anything is sent:
- the target and the line exist, and the line is a standard line (move and remove also take phaser lines);
- the referenced group, preset, MAtricks, filter and generator exist (`Assign Filter <missing>` and `Assign Generator
  <missing> At <line>` answer OK and change nothing on 2.5.1.1);
- `values` and `generator` are not both given (a line holds one of them), and `generator` is only on a preset target.

`enabled: false` switches a new line off before it gets values, so it never cooks. The filter is assigned before the
values for the same reason: the line is never cooked unfiltered.

Each `set` reply is compared for its property: Enabled by its truth value, SelectionMode, Name and Values as text (an
unchanged SelectionMode is a failure, not a match). A line list read only in part fails `read_lines` before anything is
sent, and a partial read of the target's data is named in `warnings` (the coverage and `autoCooked` are then partial).
Afterwards the lines are read back and checked:
- add and set: every requested field of the line — selection, values (by the preset's address), MAtricks, filter and
  generator (by number), Enabled, Name, SelectionMode; the other lines unchanged (SelectionMode, filter and generator
  included). A generator assigned to a line with values must leave it without values, and values assigned to a
  generator line must leave it without a generator (both are warned);
- move and remove: exactly the expected order.

A failed `Assign` can leave an empty line behind on 2.5.1; the line count catches it. The result carries `linesBefore`,
`linesAfter`, `coverage.before`, `coverage.after`, `cookedChanges` and `autoCooked`. The coverage names the fixtures
and attributes only. `cookedChanges` compares the target's cooked values before and after, per fixture and attribute:
`added`, `removed`, and `changed` in content (value, relative, steps and their layers, phaser layers, and the preset
each value comes from, which a cooked value references). `autoCooked` is true when the coverage or a cooked value
changed, so a line moved to another preset with the same attributes (1.9010 to 21.9072: Dimmer then comes from the
phaser preset) counts as re-cooked although its coverage is the same. Verified live (onPC 2.5.1, show "Rescue",
2026-11-15, Sequence 9038 Cue 1, Group 9001 = Daytona 251-254, the code run in-process):
- `add` Group 9001 + 1.9010: `cookedChanges` `added: 4`, `autoCooked: true`;
- `set` to 1.9011 (Dimmer 0, same fixtures and attribute, so the coverage is the same before and after): `changed: 4`,
  `autoCooked: true`;
- `set` to 1.9013 (also Dimmer 100, from a second preset, so only the source changes; the raw cooked rows read
  `absPreset` 9013 instead of 9010): `changed: 4`, `autoCooked: true`;
- `set` back to 1.9010: the same.

The cooked rows of a cue part carry `absPreset`, as the fake console models them, and the cue read
`ownNonCookedDataPresent: false`. Not run on a console: a change in steps, phaser layers or relative alone, and a
preset target.

`values` is the plain string `"4.2"`. A number is refused with that form in the error: as JSON numbers `4.20` and `4.2` are
the same, as presets they are preset 20 and preset 2. A string with quotes inside it (`"\"4.2\""`) is refused the same way.

### MAtricks select on a line

A standard line's X select (`X k`, with `XWings`, `XBlock`, `XGroup`) gives values to part of its group. The select
comes from the line's own columns or, when the line has one, from its MAtricks object (the line's own `X` then reads
None). The prediction of `gma3_recipes`, `gma3_cook_recipes`, `gma3_edit_recipe` and `gma3_store_recipe_cues` keeps
the fixtures the console keeps (`src/tools/matricksselection.ts`), measured on onPC 2.5.1:

- the positions follow the group's stored grid, not its stored order: Group 9001 is stored 252, 251, 253, 254 with
  x 1, 0, 2, 3, and its selection order is 251, 252, 253, 254. Rows do not change it when x is the rank: Group 9013
  (x 0 to 11 on 3 rows) keeps what one row keeps;
- XWings w, then XBlock b, then XGroup g give each rank a position: in each of the w wings (P / w ranks) an even wing
  counts up and an odd one down; b neighbours make one position; with XGroup the position is (block mod g);
- X k keeps the fixtures at position k − 1. Past the last position (XGroup 2 with X 3, 2 blocks with X 4) it keeps
  none: no wrap-around, the line cooks nothing (a `problem`).

The fixtures it drops are checked after the cook like the attributes a filter keeps out: a cooked value on one of them
is a mismatch. Not predicted (named in `notPredicted`, so the cook is not a false mismatch): a Y or Z select; Y or Z
wings, blocks or groups with a select; XWidth, XShift or XShuffle with a select; an invert flag or the Mirror transform
with a select; XWings that do not divide the group; a grid whose x is not the rank 0 to n − 1 (gaps, or fixtures
sharing a column as in a 4 × 3 grid) or with several Z layers; an inactive MAtricks object; a line with its own select and a MAtricks object (or the object and its own columns, one of
them with a select); a generator line with a select; a setting that cannot be read. Without a select, wings, blocks and
groups only spread timing and phase: every member gets values.

### Phase and a MAtricks select

A select does not narrow the phase spread. Measured on onPC 2.5.1:

- a phase range on the line itself (its own `PhaseFromX` / `PhaseToX`, its MAtricks object's, or a phaser line's
  phase) is spread over the X positions of the **whole group** in selection order. The kept fixtures get the phase of
  their position, and the fixtures of one position (a block, a group, a wing pair) share it: XBlock 2 with X 2 and
  0 → 360 gives 253 and 254 both 180°; X 3 alone gives 253 180° (of 0 / 90 / 180 / 270); XGroup 2 with X 2 gives 252 and
  254 both 180°;
- a line without a range of its own that calls a phaser preset keeps the phases the preset spreads on its own line's
  group: Group 9001 with XGroup 2, X 1 on 21.9032 (0 / 120 / 240 / 359.9) cooks 251 at 0° and 253 at 239.93°.

So a standard line whose select keeps part of its group and whose values are a phaser gets a `phaseNote` (a warning in
`gma3_cook_recipes` and in `gma3_store_recipe_cues`' cook) when the line has a phase range or the preset's phases differ
across the group. It names the kept fixtures and says what the console does; in the two measured cases it gives the
phases, and the cook's read-back then checks each kept fixture's cooked phase (`cooked phases other than predicted`).
The phases are not predicted (the note says why) with a Y or Z range, more groups than positions, RelativePhase off, or
a preset that has phases of its own under a range on the line (how they add up is not verified). A phaser line (in a
preset or a cue) with a select and a phase range gets the same note in `gma3_recipes` and `gma3_cook_recipes`, with the
shared phase; its coverage is not predicted, so that phase is not checked after a cook. A line whose select is itself
not predicted (a 4 × 3 grid, Width...) still gets the note, without the fixtures or their phases. A predicted phase is
not checked where another line of the part also writes that fixture and attribute (the last one wins), or where a line
that is not predicted may reach it (a `dependencyNotes` entry says so).

## `gma3_store_recipe_cues`

`{sequence, mode: "replace" | "append", cues: [{cue, part?, name?, note?, phasersync?, appearance?, lines: [line, ...]}], cook?, replace_uncooked?,
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

The cue part's properties (they used to need `gma3_set_property` after the build; `gma3_store_cues` has no code for
either):

- `phasersync`: `true` sets `PhaserSync` = Yes on the entry's own part: a phaser that part starts locks onto the
  phasers already running instead of starting from zero (the THK migration's bench, 14 Nov. 2026). `false` or `null`
  clears it by writing `""`: the console refuses `"No"` (Lua `set` keeps the old value and replies with it; the command
  line answers "Illegal value").
- `appearance`: an Appearance pool number, or a name, resolved by `check_references` to exactly one appearance (names
  compare case aside; a name shared by several is refused: give the number). `null` or `""` clears it. It is written on
  the cue's **Part 0**, whatever the entry's part: the cue object has no Appearance, Part 0's is the cue's (the THK
  migration bench; `Assign Appearance N At Sequence S Cue C` also lands on Part 0). Two entries of one cue that
  ask for different appearances are refused. Parts 1 and above have an Appearance of their own, which this tool does
  not write.
- Both are written by Lua `set` (`PhaserSync` "Yes" / "", `Appearance` the number as text / ""), after the lines,
  the name and the note, and are not cooked data (the part stays `ownNonCookedDataPresent: false`). Not the command
  line: `Assign Appearance N At ...` creates Appearance N when it is missing. A missing number or name is refused
  before anything is sent, because `set` with one clears the appearance there without an error.
- In `append` mode an entry may leave out `lines` (or give `[]`) when it sets `name`, `note`, `phasersync` or
  `appearance`: that updates an existing cue without touching its lines (e.g. `{cue: 1, phasersync: false}` clears
  it). `replace` always needs lines. An omitted field sends nothing.

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
   - `set PhaserSync` on the part and `set Appearance` on Part 0 (each reply checked: "Yes" / "", the appearance's
     name / "");
   - a read-back: the line count, every field written (the preset by its address, the filter by its number), the columns in the display role, the
     lines that were there before unchanged (append), the name and the note (exactly), PhaserSync (display role) and
     the appearance (its number from the raw role; once cleared it is absent there, so empty is confirmed as `""` in
     the display role). The item's line has the count, the properties written and only the mismatches.

   A part's steps stop at its first failure; what was sent stays (nothing is undone or retried) and its summary says
   which step stopped it. Other parts go on unless `stop_on_failure: true`; a request without a reply stops the rest
   of the call.
5. `cook` (a `gma3_cook_recipes` mode), only when every part was written and matched: each part is cooked with
   `gma3_cook_recipes` (its inspection, its `replace_uncooked` refusal and, unless `verify_cook: false`, its read-back),
   one after the other. A cook that does not succeed leaves the call `partial`; the parts stay written.
6. `read_properties`, after a cook: the properties are read once more, so `properties` in the result (per part:
   `phasersync: {ref, value}`, `appearance: {ref, value: {no, name} | null}`) is the state at the end of the call; a
   change is a mismatch.

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

## Generators on a preset line

A ma2 Random effect becomes a **generator** (ma3 Generator pool, `ShowData.DataPools.Default.GeneratorTypes.Generators`,
class Random) on a **standard** line of a preset: `Assign Generator N At Preset P.N.L`, in place of the values preset.
The line cooks a token value (6500) on every member of its group that has a channel's attribute, and a cue that
calls the preset with a standard line stays 100 % recipe. The console facts (onPC 2.5.1.1, 2026-11-15):
- a line holds a values preset **or** a generator: `Assign Generator` clears the values and `Assign Preset` the
  generator; `set Generator ""` clears it (the line then cooks nothing); `Assign Generator <missing>` answers OK and
  changes nothing;
- the line re-cooks by itself on the Assign, like any other line;
- the line's Speed X has no effect on a generator: its speed is the channel's own (cycles per minute).

`gma3_recipes` and `gma3_cook_recipes` read the generator (`readGenerator`: its channels with asText false and as text)
and predict the line on the channel attributes the group's members have (`fixtureAttributes` per member): a Pan
channel on a fixture without Pan is not expected. A generator that cannot be read completely, or a generator line with
values or a filter, is not predicted (named); a missing generator is a problem ("the line cooks nothing").
`gma3_edit_recipe` takes `generator` only on a preset target: a generator on a cue line was not tried on the console;
the cue calls the preset instead.

## `gma3_store_generator`

`{generator, action: "create" | "edit", name?, channels?: [{channel?, attribute?, speed?, ratio?, attack?, decay?,
low_variance?, high_variance?, phase_variance?, speed_master?}], preview?}`.

| Field | Console property | Range | Note |
| --- | --- | --- | --- |
| `attribute` | `Assign Attribute "<Attr>" At Generator N.2.k` | an attribute name | a `set` is refused; an unknown attribute answers "Illegal object" |
| `speed` | Speed | 0.001-6000 | **cycles per minute** (15 = one cycle every 4 s); reads raw in cycles per minute, as text in Hz |
| `ratio` | Ratio | 0-100 | % of the time at the high level (about the ma2 Width) |
| `attack`, `decay` | Attack, Decay | 0-100 | % |
| `low_variance`, `high_variance` | LowVariance, HighVariance | 0-100 | % (100 with attack / decay 0 is about a ma2 random) |
| `phase_variance` | PhaseVariance | 0-360 | degrees (360 spreads the fixtures) |
| `speed_master` | SpeedMaster | 1-16, `0` / `null` clears | master 3.n, **sent 0-based** (`"1"` is 3.2), cleared with `"None"`; reads back as the master's name |

1. Checks: `create` needs a free slot and every channel's attribute; `edit` needs the generator (a Random one, read
   completely), a channel number per entry, and new channels at count + 1, + 2, ... with their attribute. Values out
   of range are refused (the console clamps them silently: Ratio "150" stores 100). A speed master must be in the
   show (a duplicate or empty master name is warned: the read-back is by name). When the call would `Store`
   (`create`, or a new channel), the programmer must be **known to be empty** (`programmer`, a complete scan): the
   tool refuses otherwise and never clears it.
2. `create`: `Store Generator N /NoConfirmation` (one channel: Dimmer, Speed 60, Ratio 50, Attack 100, Decay 100,
   variances 0); each further channel `Store Generator N.2.k /NoConfirmation` (read on a new channel: Attack and
   Decay 100, variances 0; its attribute, speed and ratio were always written before any read). Then per channel
   `Assign Attribute`, then one `Set Generator N.2.k Property "<P>" "<v>"` per setting given (the console takes one
   property per command). Then the name (`set`).
3. Read back: the channel count, each written attribute and setting (the percent fields as text: raw they read
   truncated, RATIO 19 for 20), the speed master by name, on `edit` the channels not asked for unchanged, and the
   name. The result has every channel field (`generator.channels`, the unwritten ones under `other`).

Nothing is undone after a failure: a generator created before a failed step is kept, and the warnings say so. The
speed master link takes effect at the next Goto of the cue that plays it, and the master multiplies the channel's
speed (both from the THK migration bench; not re-measured here).

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

**Same steps on several lines (one effect split by family or group).** Two lines with the same 2 step presets (or hard
values) are a duplicate only when they act on the **same selection**: the same Group and the same MAtricks (lines 2+ keep
line 1's MAtricks unless they give one). That is refused, in `create`, `add_line` and `set`, naming the selection:
two identical lines would cook the same values twice. The same steps on lines of **other groups** (or another MAtricks)
are allowed. A line is identified by its index (`line`, which `set` and `remove_line` take; the lines after a removed
one move up), and the read-back identifies a cooked value by its steps **and** its line's selection: when a line has such
a twin, the cooked values on the fixtures of its group are its own (the group is read once, `group.read`), so its speed,
curves, trans, width and measure are compared on those values only, and the twin's values count as "other lines
unchanged". Twins whose selections share fixtures (the same group with another MAtricks, or overlapping groups) cannot be
told apart by fixture: the call warns, the line's evidence (it cooked) is still checked, but speed, curves, trans and
width of the shared values are not compared per line.

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
  can be told apart by their value sources (a plain shape: each step from a preset or from hard values).
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
preset pool, hold the source's attribute and are not the preset itself; no other line **on the same selection** (Group and
MAtricks) has the same 2 step presets (or hard values) on the same attribute (a source left to the shape's value on two lines is allowed: its values are only checked where
one line alone can have made them); group, shape, MAtricks and step presets exist; no dialog is open; the Edit Recipe
mode is off.

Read back:
- every line as expected: group, MAtricks, shape, speed (SPEEDX raw, in Hz), phase, measure, cook state, each value
  source's preset, and its ACCEL / DECEL / TRANS / WIDTH where they are known. After a new shape or a reset they are
  the shape's and are not compared; after a width the other step's is the sum minus it, and the trans of that source
  is not compared unless given;
- the edited line's cooked values come from its 2 step presets (or hard values) at its speed, and no value is left
  from its old step presets;
- every other cooked value unchanged, and nothing uncooked added. A fixture and attribute that the edited line
  outputs, before or after, is left out of that comparison: where two lines act on the same attribute of the same
  fixture, the later line's value wins, so another line's value may rightly appear or go.

`add_line` and `remove_line` also need the line (line 1 for `add_line`) to be 2 steps from presets or hard values:
the read-back tells cooked values apart by their step presets or hard values.

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
  sequence, within 1000 cues and 120 s; with `sequences` a warning says that cues in other sequences were not
  searched (with the reference count). An incomplete scan is reported (`recook.complete: false`, the reasons, a
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
- Verified live for the MAtricks select (onPC 2.5.1.1, show "Rescue", 2026-11-15, Group 9001 of 4 Daytona stored
  252, 251, 253, 254 with x 1, 0, 2, 3, and Group 9005 of 12 dimmers stored 2–12, 1 with x 1–11, 0; cooked
  `/MergeLowPriority`; the code run directly against the bridge). `gma3_store_recipe_cues` wrote the per-line columns
  (`x: {groups: 2, select: 1}`, `{blocks: 2, select: 2}`, `{select: 3, phase: ...}`) and MAtricks references, each read
  back matched; the cooked fixtures, read with `preset.read`:
  - MAtricks 9009 (XGroup 2, X 1) with 1.9010, and the same as the line's own columns: 251, 253;
  - own X 3: 253; own XBlock 2, X 2: 253, 254; own XGroup 2, X 2: 252, 254;
  - MAtricks 9010 (XWings 2, X 2) on Group 9005: 2 and 11 (the second wing counts down); MAtricks 9012 (XWings 2,
    XGroup 2, X 1): 1, 3, 5, 8, 10, 12 (wings before groups; without them it would be 1, 3, 5, 7, 9, 11);
  - own XGroup 3, X 1 on Group 9013 (x 0 to 11 on 3 rows): 1, 4, 7, 10, as on one row;
  - MAtricks 9011 (XGroup 2, X 3) and MAtricks 9002 (XBlock 2, X 4) on Group 9001: nothing cooked;
  - the earlier bench cues read again: Sequence 9019 cue 9 (MAtricks 9001, XGroup 3, X 1, Group 9005): 1, 4, 7, 10;
    cues 2 and 10 (XBlock 2, X 4, own columns and MAtricks 9002): 7, 8; preset 21.9049 (XWings 2, XBlock 4, X 2):
    5, 6, 7, 8 (this one keeps the same fixtures with or without the wings, so it does not show their order).

  The cook of Sequence 9033 (13 cues) read back `matched`, with the two empty ones named as cooking nothing and the
  4 × 3 grid (cue 13) not predicted; the old prediction had read 5 of the first 10 `mismatched`. Sequence 9034 cue 1, built by `gma3_store_recipe_cues` with Group
  9001, MAtricks 9009 and the phaser preset 21.9072 (Dimmer and Pan), cooked 251 and 253 (`matched`,
  `ownNonCookedDataPresent: false`); played back, the output of 251 and 253 moved (251: Dimmer 7221–58939, Pan
  26440–39096 of 65535 over 4 s) while 252 and 254 stayed at Dimmer 0 and Pan 32768. XWings with a count that is not
  a multiple, Width / Shift / Shuffle, inverts, Y and Z selects and grids with shared columns were not run with a select (cue 13, a 4 × 3 grid, cooked 1 and 5 for X 1: not
  modelled).
- A standard line's own MAtricks columns and individual timing, from the THK migration bench (2026-11-15, 2nd series,
  Sequence 9019, Group 9005 of 12 dimmers; the bench wrote the columns with `gma3_store_recipe_cues`, cooked them and
  saw them in the output). Read again here (2026-11-15, `preset.read` on the cue parts, read only), every value
  `cooked`:
  - Cue 3, own `XWINGS 2`, `FADEFROMX 0` / `FADETOX 3` on 1.9031 (Dimmer 100): fade 0 on fixtures 1 and 12, then 0.6,
    1.2, 1.8, 2.4 up to 3 on 6 and 7 (outer edges to the centre);
  - Cue 4, own `FADEFROMX 2` / `FADETOX 2`, `DELAYFROMX 0` / `DELAYTOX 0.5` on 1.9032 (Dimmer 0): delay 0 on fixture 1
    rising by 0.045 to 0.5 on 12, fade 2 on all;
  - Cue 11, the same as cue 3 through MAtricks 9003 ("TEST B2 XWINGS2 FADE": XWINGS 2, FADEFROMX 0 / FADETOX 3, read
    the same day): the same fades.

  So the cook bakes a line's fade and delay per fixture into the cue part (a cue stored from the programmer with a
  recalled MAtricks does not: [SB-02](../probes/sb-02-groups-macos-2.5.1.md)). Not verified by the tools: they write
  and read back the columns, but they neither predict nor compare the per-fixture fade and delay a line cooks.
- Verified live for the phase note (same bench and day): Sequence 9033 cues 2, 6, 8, 9 and 10 cooked the phases the note
  gives (251 0° / 253 239.93°; 253 180°; 253 239.93° / 254 359.9°; 253 and 254 180°; 252 and 254 180°), and the cook of
  Sequence 9033 read back `matched` with the phase check on. `gma3_recipes` on the phaser presets 21.9048, 21.9049 and
  21.9050 (Group 9005, MAtricks 9004, 9005, 9001, phase 0 → 359.9) gave 179.95°, 359.9° and 0°, the phases they hold.
  Sequence 9035, built by `gma3_store_recipe_cues` and cooked (`matched`, `ownNonCookedDataPresent: false` on both
  cues), with the warning on each:
  - cue 1, Group 9001 + MAtricks 9009 + 21.9032 (a 10 s Chase): in the output, 251 lit from 0 to 2.5 s and again at
    10.1 s, 253 from 6.3 to 8.8 s (240° later, within the 0.65 s sampling), 252 and 254 stayed at 0;
  - cue 2, a reference line Group 9008 (251, 252) + 21.9072, and Group 9001 with its own XBlock 2, X 2 and 0 → 360 +
    21.9072: the Dimmer of 253 and 254 moved together, opposite to 251 and 252 (minimum at 1.6 s against maximum, over
    4 s), i.e. both at 180°.

  Sequence 9033 cue 13 (Group 9010, a 4 × 3 grid, own X 1, the phaser preset 21.9061) got the note without fixtures or
  phases, its select not predicted. Not run: a Y or Z phase range with a select, wings with a phase range on a cue line, a preset with phases of its own
  under a range on the line.
- Cue names on Part 0 and `set` on lines are verified (SU-06, SB-05); the cue's `Note` is not. How a column reads in the
  display role while a MAtricks reference supplies it (`<2>`) is not known (the typed read gives None).
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

  Sequence 9000 Cue 11 (one standard line calling 21.9005) followed every one of these changes without a re-cook.
  That is not the rule: other cues kept old values until re-cooked (see [`recook`](#re-cooking-the-calling-cues-recook)).
  The order of `create` (curves after the copies) was verified live too: 21.9006, a Dimmer line with Snap on step 1
  and an RGBW line without a curve, matched; line 2 kept the Sine curve (TRANS 100) instead of line 1's Snap. A copy
  keeps line 1's Snap, and `Assign Preset` keeps it too.
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
    time (Dimmer came from 21.9072, 2 steps, then from 1.9010 again); `gma3_cook_recipes` of the sequence matched (8 + 4);
  - not run on a console: the "keeps out" mismatch (fake bridge only: the console always applied the filter); a filter
    on a line in a preset; a filter on a colour preset where the rest of the activation group might cook too (the check
    would report it as kept out); filters with several rules, a layer off, inverted rules or APPLYTOFIXTURES Yes (left
    not predicted). The cook check is per fixture and attribute, not per line: in Cue 1 above, a filter that the
    console ignored would still have read back matched, because line 1 also predicts the Dimmer pair.
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
- Verified live for generators (onPC 2.5.1.1, show "Rescue", 2026-11-15, Group 9001 = Daytona 251-254, the code run
  directly against the bridge):
  - by hand first (Generator 9003, preset 21.9076): the commands of the THK bench, the defaults of a new generator and
    of a new channel, the raw / text reads, SpeedMaster `"0"` = Speed1 (3.1), `"2"` = TILT (3.3), `"None"` clears;
    "Illegal object" for an unknown attribute, "Illegal value" for "abc", Ratio "150" stored as 100; `Assign
    Generator 9999` answered OK and changed nothing; values and generator replace each other on a line; `set Generator
    ""` cleared it (the preset re-cooked to nothing);
  - `gma3_store_generator create` 9004 "TEST GEN I5": Dimmer (speed 15, ratio 20, attack 0, decay 0, variances 100,
    phase variance 360) and Pan (speed 7.5, ratio 50, phase variance 360, speed master 2): the empty programmer
    checked, every command OK, matched (Pan read "PAN"); after the output check below, `edit` channel 2 (attack 0,
    decay 0, speed master `null`): matched, channel 1 unchanged;
  - `gma3_edit_recipe add` on the empty preset 21.9077 (`Store Preset 21.9077 /NoConfirmation`): Group 9001 +
    generator 9004, matched, auto-cooked 8 values (Dimmer and Pan, 6500, on the 4 fixtures). `gma3_recipes` predicted
    8 pairs (`generatorAttributes` Dimmer, Pan, no problem); `gma3_cook_recipes` of the preset matched. On 21.9076,
    `set generator` 9003 over values (warned), `null`, 9003 again, then `set values` 1.9010 over the generator
    (warned, the generator cleared): each matched; the new `gma3_recipes` on the bench presets 21.9040 (generator
    9001, Dimmer: 4 pairs) and 21.9041 (a values line and a generator line, ColorRGB_G / _B: 16 pairs) found no
    problem;
  - Sequence 9032 Cue 1 (`Store Sequence 9032 Cue 1 /NoConfirmation`) = Group 9001 + 21.9077 (`gma3_edit_recipe`),
    cooked merge low priority: matched, `ownNonCookedDataPresent: false`, 8 cooked values;
  - output after `Go+ Sequence 9032` (16-bit; asked every 200 ms, an effective resolution of about 650 ms over 16 s):
    the 4 Dimmers jumped between random levels (3200 to 65484), about every 4 s (15 cycles per minute), each fixture
    at its own time (phase variance 360). Pan (variances 0, attack / decay 100, linked to master 3.2, which stood at
    60 BPM, scale One; resolution about 530 ms over 12 s) ramped up and down with a period of about 8.2 s (7.5 cycles
    per minute: 8 s), 251 and 253 out of phase. At 60 BPM the master multiplies by 1, so this neither confirms nor
    contradicts the bench note that the master multiplies the speed. Sequence 9032 was switched off;
  - not run on a console: a generator on a cue line (refused by the tool), several generators on one preset, a
    generator line with a filter or MAtricks, a generator whose settings change while a cue plays it (whether the cue
    follows without a re-cook), the speed master multiplying the speed at another BPM than 60 (the bench notes say it does),
    `edit` appending a channel (fake bridge only), channels beyond 2, generator types other than Random.
- Relative layers, from the THK migration bench (2026-11-15; not re-run here, the bench objects read again with
  `preset.read` and `gma3_recipes`, read only):
  - a "relative only" preset: 2.9044 "TEST B4 PAN REL 0" (4th series) was stored with `gma3_store_preset` (`layers:
    [relative]`, `attributes: [Pan]`) after `Attribute "Pan" At Relative 0` and `Off Attribute "Tilt"` in the
    programmer. It holds 4 rows, Pan on 251-254, each `hasAbsolute: false`, `hasRelative: true`, `relative: 0`. A line
    calling such a preset stops a relative phaser on its attributes (Pan + Tilt relative 0 preset 2.9040, 1st series,
    and 2nd series in Sequence 9022: Cue 3 = Group 9001 + 2.9030 + 2.9040), where neither the base preset, another
    absolute preset nor a RELEASE does. `gma3_store_preset` now counts a relative of 0 as a relative layer, compares
    it in the read-back, and `gma3_preset` lists `relative: 0` (verified live on 2.9045, Pan + Tilt relative 0, see
    [presets](presets.md#what-is-and-is-not-verified));
  - a new relative phaser takes over an attribute's relative layer: Sequence 9025 Cue 1 = Group 9001 + 2.9032 (base)
    and Group 9001 + 21.9054 (relative Pan + Tilt phaser A); Cue 2 = Group 9001 + 2.9044 (Pan relative 0) and Group
    9001 + 21.9060 (relative Tilt phaser B). In Cue 2 the bench saw Pan held on the base and Tilt follow B alone
    (B's amplitude and speed, nothing left of A). Both cues read 8 cooked values (Pan, Tilt on 251-254) and nothing
    uncooked. Not tested: the same relay without the relative 0 on the attribute B does not set (Pan here).
- Verified live for `phasersync` and `appearance` (onPC 2.5.1.1, show "Rescue", 2026-11-15, Group 9001 = Daytona
  251-254, the code run directly against the bridge):
  - by hand first, on Sequence 9036 (2 empty cues): the cue object has neither property, every part has both. Lua
    `set PhaserSync`: "Yes" and "1" set it (replies "Yes", raw `true`), `""` clears it (reply `""`, raw `false`);
    "No", "On", `true` and `false` sent over Yes were kept, the reply being the old value (`true` and "On" sent over
    `""` did not set it either). Command line `Set ... Property
    "PhaserSync" "No"`: "Illegal value". Lua `set Appearance`: "9000" and "TEST RELEASE" assign Appearance 9000 (reply
    the name, raw a handle with its index); `""`, "Appearance 9000", "#FF0000", "Red", a missing number "8999" or a
    missing name, each sent over Appearance 9000, cleared it without an error. `Assign Appearance 9000 At Sequence 9036 Cue 2`
    landed on Part 0; `Assign Appearance 8999 At ... Part 0` answered OK and **created** Appearance 8999 (deleted
    afterwards). Part 1 took its own PhaserSync and Appearance. Line writes, `Cook ... /MergeLowPriority`, `Cook ...
    /Overwrite` and `Store ... /Merge` (empty programmer) kept both;
  - Sequence 9037 ("ITEM8 PROPS", 2 empty cues), `replace`, cook merge low priority: Cue 1 = Group 9001 + 1.9010 and
    Group 9001 + 21.9072, `phasersync: true`, `appearance: "TEST RELEASE"` (resolved to 9000); Cue 2 = Group 9001 +
    1.9010, `phasersync: false`. Matched, both cooks matched; `properties` after the cook: Cue 1 PhaserSync true,
    Appearance 9000 "TEST RELEASE"; Cue 2 PhaserSync false. Read again by hand: Cue 1 Part 0 PhaserSync "Yes",
    Appearance "TEST RELEASE", Cue 2 PhaserSync "" and Appearance ""; `ownNonCookedDataPresent: false` on both, and
    `gma3_cue_contents` of Cue 1 listed 8 values, all `cooked: true`;
  - `append` with `{cue: 1, phasersync: false}` (no lines): matched, PhaserSync "" , the 2 lines and the appearance
    kept. `replace` of Cue 1 with the same lines and `phasersync: true`, cooked: the appearance survived the deletes and
    the cook. Then `{cue: 1, phasersync: false}` and `{cue: 2, appearance: 9000}`, then `{cue: 2, appearance: null}`:
    each matched and read back. `appearance: 8999` was refused by `check_references`, nothing sent, Appearance 8999
    not created;
  - output after `Goto Sequence 9037 Cue 1` (16-bit, sampled every 200 ms, about 420 ms resolution, 4 s): the Dimmers
    of 251 and 252 swung between 6933 and 58939 (11 % to 90 %) with a period of about 2 s, Pan moved around its centre
    (28022 to 39279), as preset 21.9072 does. Sequence 9037 was switched off;
  - not run on a console: what PhaserSync does to a phaser (the migration bench of 14 Nov. 2026 measured it, not this
    tool), a name shared by several appearances (fake bridge only), PhaserSync on a part above 0 through the tool (set
    by hand only), an entry without lines combined with `cook`, and the post-cook mismatch (the console kept both
    properties in every cook tried).
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

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/recipes.live.ts` on a disposable show with an empty programmer and
bridge 0.24.0. It uses Sequence 906, Groups 910–911, Presets 23.931 and 4.931, the fixtures 401–404
(`GMA3_LIVE_RECIPE_FIXTURES`) and the presets 4.4 and 1.11 (`GMA3_LIVE_RECIPE_COLOR`, `_DIMMER`), refuses to run when
those objects exist, and deletes them at the end.
