# OSC input and output (SU-18)

Read and configure the console's OSC input and output, and prove that input works, without Lua or a shell. Needs
bridge 0.33.0. The loopback test also uses bridge 0.31.0's variable ops.

| Tool | What it does |
| --- | --- |
| `gma3_osc` | Read-only: input and output switches, Interface and PreferredIP, every OSC line, the network interfaces, what they mean, and whether the console really holds each receiving port's socket |
| `gma3_configure_osc` | Switch input and output, re-bind input, set the preferred IP, add / edit / remove lines; preview, read-back |
| `gma3_test_osc_input` | Send a loopback `/cmd` that sets a marker variable and read it back; on a failure, check the socket |

## What the console does (onPC 2.5.1, macOS)

From the probe ([su-18-osc-config-macos-2.5.1.md](../probes/su-18-osc-config-macos-2.5.1.md)):

- **Input listens on every interface.** With input on, the console's socket is `UDP *:<port>`. A command sent to
  the machine's LAN address was run with PreferredIP `127.0.0.0/8`, and even with `10.0.0.0/8`, which matches no
  interface (Interface `0.0`). Interface and PreferredIP do not limit who can send. Once a line runs commands,
  anyone who can reach the machine can run commands on the console.
- **PreferredIP picks Interface:** `192.168.0.0/16` gives en0, and `127.0.0.0/8` gives lo0.
- **Re-binding:** EnableInput off closes the socket and on opens it. A line's port change takes effect only after
  input goes off and on again. Changing PreferredIP or toggling Receive does not re-bind.
- **Input can read on with nothing bound** (migration bench, 15 Nov 2026, onPC 2.5.1): EnableInput read Yes and line
  1 had Receive Command on port 8000, but `lsof` showed no socket on UDP 8000 and the loopback test failed. Switching
  input off and on bound the port again. The cause is unknown and the state was not reproduced. The settings alone
  cannot show it, hence the [socket check](#socket-check).
- **Receive Command** runs `/cmd`. Receive (faders, keys) is not needed for commands.
- **Prefix:** with a prefix the address is `/<prefix>/cmd`, and a plain `/cmd` is ignored.
- **Output:** a line with Send, while EnableOutput is on, sends playback changes (such as
  `/14.14.1.7.1 FaderMaster`) to DestinationIP:Port. Commands sent through the bridge were not echoed by Send
  Command.
- **New lines:** the console creates one as UDP, port 8000, destination 127.255.255.255, with nothing on. A line's
  Name displays as `OSCData 2 'name'`, so the bridge reads the object's own name.

## gma3_osc

Returns the bridge's `osc.read` plus `meaning`:

- `input`: `enabled`, `acceptsCommands` (input on and a line with Receive Command), `commandLines` (line, port,
  address), `reachableFrom` (loopback plus every address outside loopback), and an `explanation` in words.
- `input.listening`, when input is on: the [socket check](#socket-check) with its `finding` in words and, when a
  receiving port is not held by the console, `fix` (the re-bind call). A conclusive "not listening" makes
  `acceptsCommands` false for the lines on that port, and the `explanation` says the console is not receiving there
  instead of saying that it runs commands; `reachableFrom` drops that port and `serverSender` says this server's
  sender cannot reach the console until input is re-bound.
- `output`: the lines that send and where (`loopback` per destination).
- `serverSender`: this server's own OSC target (`GMA3_OSC_HOST`, `GMA3_OSC_PORT`, `GMA3_OSC_PREFIX`), and the line
  that runs its commands, or a note that `gma3_command` via OSC and `gma3_start_bridge` cannot reach the console.

## gma3_configure_osc

| Parameter | Meaning |
| --- | --- |
| `enable_input`, `enable_output` | The two switches |
| `rebind_input` | `true`: switch input off, wait 0.4 s, switch it on, nothing else. For input that reads on while its socket is not bound. Needs input on (refused when it reads off: `enable_input: true` binds the ports); not with `enable_input: false`. Opens no new port, so no `network: true` |
| `preferred_ip` | IPv4 network such as `127.0.0.0/8`; it picks the interface and does not limit who can send |
| `lines` | `{line: n, ...}` to edit, `{add: true, ...}` to add, `{line: n, remove: true}` to remove |
| line fields | `name`, `port` (1-65535), `prefix` (letters, digits, `_`, `-`; `""` for none), `destination_ip`, `receive`, `receive_command`, `send`, `send_command`, `echo_input`, `echo_output`, `note`. Lines are UDP; mode is not configurable. |
| `network` | Required when the change opens a port that runs commands while the machine has an address outside loopback, or adds output to an address outside loopback |
| `preview`, `verify`, `exclusive` | `exclusive: true` is required unless `preview` |

Order of steps:
1. Input or output goes off first, when the request switches it off.
2. Per line, in this order:
   1. flags that go off;
   2. Send and Send Command of a line that is sending now go off while its destination or port changes;
   3. the other values;
   4. flags that go on;
   5. the temporarily disabled send flags back on, when the final state still wants them.

   No intermediate state sends to a new address or runs commands on a port the final state doesn't confirm.
3. Removals, from the highest number.
4. The preferred IP.
5. A re-bind, when input stays on and an existing line's port changed, a receiving line was added, or `rebind_input`
   is given: EnableInput off, a 0.4 s wait, then on.
6. Input and output go on last.

Checks while applying:
- Each write is judged by the value the console answers, and each addition or removal by the line count.
- A step the console did not take, or whose answer is unreadable, stops the call. The unsent steps are listed as
  skipped.
- Nothing is resent. An uncertain step is decided by the read-back. If a re-bind's "on" did not succeed and input
  reads off, the result says so and names the way back (`enable_input: true`); it does not switch input on by
  itself.

The read-back compares the switches, the preferred IP, every named line property and the line count. `previous`
holds the configuration before the call, since there is no undo. After a re-bind whose "on" succeeded, the socket
check runs too (once more after 0.4 s if a port is not held yet): a receiving port the console still does not hold
makes the verification `mismatched`. The result carries it as `socketCheck`.

**Unknowns are never taken as safe:**
- If the console does not report EnableInput, EnableOutput, or a line's Port, Receive Command, Send, Send Command
  or DestinationIP, the call is refused: nothing about the network can be judged from them.
- An incomplete interface scan (`interfacesComplete` not true: a failed enumeration or an unreadable address) counts
  as networked.

**Network rule.** The console listens on every interface, so a port that newly runs commands is reachable by
anyone on the machine's networks. The tool refuses without `network: true` and says so in plain words. A prefix or
name change on a port that already runs commands opens nothing new.

## gma3_test_osc_input

For each line with Receive Command (or the `line` given), the tool:
1. sends `/[prefix/]cmd SetUserVariable "McpOscTest" "<nonce>"` to `127.0.0.1:<port>`;
2. polls the bridge user's variable for up to `timeout_ms` (default 1500);
3. reports `matched` when the console ran the command.

OSC commands run as the bridge's user, so the bridge reads that same user's variable.

Before sending, the marker must read as confirmed absent. If it exists, or the read gives no clear answer, nothing
is sent or deleted, so a show's own variable is never overwritten. The test also refuses when input is off or no
line runs commands.

Per line, `received` takes one of three values:
- `true`: the nonce was read.
- `false`: reads worked, but the nonce did not appear within the window. Verification is `mismatched` with "not
  observed", which is not proof that the console didn't run the command. The tool then runs the
  [socket check](#socket-check) on the failing lines and puts its finding in the detail, and in `socketCheck`:
  - console holds no socket on the port: the re-bind call;
  - another process holds the port: who, then the re-bind;
  - the console holds the socket: the cause is elsewhere (prefix, firewall, command line);
  - not checked: the usual causes (input not bound, a port change without a re-bind, a firewall, another program on
    the port) and why the check was not done.
- `null`: no read worked. Verification is `unavailable`.

Each line also carries its `polls` and `readablePolls`.

After the test the marker is deleted and read again. `markerCleanup` is `deleted`, `remains` (a failed step plus a
warning on how to delete it), or `unknown`.

Loopback proves that the console receives. Since it listens on every interface, a sender on the network reaches the
same port unless a firewall stops it.

## Socket check

`src/oscsocket.ts`. It runs in `gma3_osc` (input on), after a failed `gma3_test_osc_input`, and after a re-bind in
`gma3_configure_osc`. It checks the ports of lines with Receive or Receive Command.

- **Method:** one `lsof +c 0 -nP -w -F pcPn -iUDP -iTCP:<bridge port> -sTCP:LISTEN`, asynchronous, killed after
  2 s. About 50 ms on the bench Mac. lsof exits 1 when one selection matched nothing even though it printed the
  others, so the output decides, not the exit code.
- **Anchor:** the process listening on the bridge's TCP port is the console, since the bridge plugin runs inside it.
  Its command must look like grandMA3 (`app_gma3` on macOS). Seeing it also proves that lsof can see the console's
  sockets.
- **Verdicts,** per port, and the worst one for the whole check:
  - `listening`: the console's process holds a UDP socket on the port;
  - `held_by_other`: it does not, and another process does;
  - `not_listening`: nobody does. Said only when the anchor was seen.
- **`not_checked`, with a reason, never "not listening":**
  - the bridge host (`GMA3_BRIDGE_HOST`) is neither loopback nor an address of this machine: the console runs on
    another host;
  - the bridge port is held by something that is not grandMA3, such as an ssh tunnel to a remote console;
  - lsof shows no listener on the bridge port (another user's process, missing permission);
  - Windows;
  - lsof not found (looked up in PATH, `/usr/sbin`, `/usr/bin`), not permitted, or timed out.
- **Evidence:** the result carries the command (`method`), the console's pid, command and UDP ports, and the lsof
  rows the verdict rests on.

**The fix it names:** `gma3_configure_osc {"rebind_input": true, "exclusive": true}`. The same result in two calls
(`enable_input: false`, then `enable_input: true`) leaves input closed between them, and its second call needs
`network: true` on a networked machine, because switching input on opens a command port.

## What is and is not verified

- **Verified live** (onPC 2.5.1, macOS, 15 Nov 2026, read-only):
  - `gma3_osc`: `listening` on UDP 8000 for line 1 (Receive Command), console `app_gma3` holding the bridge listener
    `127.0.0.1:9800`.
  - `gma3_test_osc_input`: matched, marker deleted; no socket check ran.
  - The real lsof path on an unbound port (8123): `not_listening`, with the console anchor seen.
  - Bridge port 9801 (no listener): `not_checked`. A non-local bridge host: `not_checked`, lsof not run.
  - `rebind_input` in preview: the three steps, no network note.
- **Unit tests only** (`test/osc.test.ts`, with a mocked check):
  - the "not listening" branch of `gma3_osc` and `gma3_test_osc_input`;
  - the `rebind_input` call, its read-back with a socket still unbound, and its refusals;
  - the two-call fallback and its `network: true`;
  - lsof missing, not permitted or timed out, a tunnel on the bridge port, Windows.
- **Not verified:**
  - `rebind_input` was not run on a console. It reuses the off / 0.4 s / on steps that the port-change re-bind uses
    live.
  - The bench failure itself was not reproduced, and its cause is unknown.
  - How soon the socket appears after the "on" of a re-bind was not measured. The check after a re-bind (any
    re-bind, port changes included) waits 0.4 s once before it calls a port unbound.
  - Whether the console binds a port for a line with Receive but no Receive Command: the bench line has Receive
    Command only. Such lines are checked as receiving.
  - Linux was not tried.
