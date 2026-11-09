# Native Korean IME preedit × clipboard acceptance (2026-11-10)

Scope: plain-text `edit.copy` / `edit.cut` / `edit.paste` (commit 22813c9) while a genuine
ibus-hangul preedit is active, in the actual Tauri/WebKitGTK debug app on Linux X11.
No application code changed for this acceptance; only test infrastructure.

## Original blocker: SetGlobalEngine timeout

Reproduced with the previous ad-hoc launcher (`ibus-daemon --panel=disable --config=disable ...`):
`ibus engine hangul` failed after ~15 s with
`org.freedesktop.IBus.SetGlobalEngine: Set global engine failed: Timeout was reached`.

Cause (observed by wrapping the engine command line and logging its exit status):
`ibus-engine-hangul` 1.5.5 obtains its settings through the IBus config component. With
`--config=disable` it logs `Unable to connect to IBus config component` and **exits with status 3**
about 20 ms after the daemon spawns it. The daemon then waits for a factory that never registers,
and SetGlobalEngine times out. The geul application was not involved.

Two environment pitfalls were also found and are handled:

- The development shell's `LD_LIBRARY_PATH` contains a glib that needs `GLIBC_2.43`; the installed
  IBus binaries use glibc 2.42 and fail to load with it. The session drops `LD_LIBRARY_PATH`.
- Unix socket paths are limited to 108 bytes; long temporary directories truncated the IBus socket
  path. Sockets live in a short private `/tmp/gx-*` directory.

## Corrected launcher

`scripts/tests/native-ibus-session.py --out DIR -- COMMAND...` starts, all owned by the test and
removed afterwards: Xvfb (1440×1000, 96 dpi), a private `dbus-daemon` whose only service directory
activates `dconf-service` (writes stay under the temporary `XDG_CONFIG_HOME`), and `ibus-daemon`
with the default config component (`ibus-dconf`) plus the installed `hangul` and `simple` engines.
The GTK IM module cache points only at `im-ibus.so`. It verifies activation before running the
command: `ibus engine hangul` exit 0 (0.16 s), global engine `hangul`, engine process alive; on
failure it exits 2 (BLOCKED) instead of running tests. `session.json` records store paths, display,
bus addresses and the activation result; `cleanup.json` records surviving processes (expected `[]`).
User IBus, D-Bus, dconf and input-method settings are never touched.

## Acceptance harness

`scripts/tests/native-clipboard-preedit.py` (run inside the launcher). Input is real XTEST keys and
pointer clicks from `xdotool`, delivered by the X server to GTK, filtered by the IBus IM module and
composed by ibus-hangul (`Shift+space` switches to Hangul, `g k` composes `하`). The page only
observes DOM events through passive capture listeners; no synthetic composition/input events are
dispatched. A separate X11 process owns CLIPBOARD and reports every read (`TEXT_REQUEST`, a Paste
reached the OS) and every ownership loss (`SELECTION_CLEAR`, Copy/Cut wrote the OS clipboard).

Each case requires: trusted `compositionstart` and `compositionupdate("하")`, focus in the editor
`.rhwp-input` and X focus on the app window, and the ribbon reporting `글자 조합 중` (the session
recognises the unsettled IME transaction). Then the command is sent, the preedit is finished with
`End` if still open, and the case verifies: no command executed before IME settlement, OS clipboard
not overwritten, at most one Paste read, no revision change during a 1.2 s late-event window, and the
exact document text via normal selection + Copy (which also proves Copy works again). At the end of
each format: genuine BackSpace cancellation, normal Cut/Paste, T009 save and an independent reopen of
the saved bytes (WordCraft XML for DOCX, RHWP WASM for HWP/HWPX).

Classification (2026-11-10 hardening; `scripts/tests/preedit_classifier.py`, unit tests
`scripts/tests/test_preedit_classifier.py`). The first version is kept in the history below. It
treated "no OS read" as a safe block, so a lost or misdirected command could have passed.

1. **Delivery.** The intended trusted command event must reach the app exactly once. That is a
   Ctrl+key `keydown` (no other modifier) on `.rhwp-input`, or a `click` whose closest
   `[data-command]` is exactly `edit.<op>`. Otherwise the case fails.
2. **One positive outcome.** Executed means one OS read (Paste) or an ownership change (Copy/Cut).
   Refused means the app's own refusal notice for *that* command (`command.unavailable.<reason>`)
   appeared after the event. Before each case the status line is primed with a refusal the tested
   command cannot produce, so the notice is always a visible change. Neither outcome (a lost
   command), both, or two reads fail the case.
3. **Expectation from the IME ordering.** A command that arrived before the IME transaction ended
   (no `compositionend` before it, or `isComposing`) must be refused. After genuine settlement it
   may execute. A refusal is accepted only with an independently validated reason:
   `pendingEdits` within 500 ms of the IME commit, or `selectionRequired` when the settled state
   shows no selection.

The rendered button state at the event is recorded (`displayedReasonAtCommand`) but does not
decide the outcome. A native run showed DOCX Ctrl+V executing while the last render still showed
`pendingEdits`. The shortcut path evaluates the live session snapshot and `runClipboard` refuses
while edits are pending, so the render was one frame behind.

Expected document text follows from the positively evidenced outcome. A Paste counts as inserted
only with exactly one read and no refusal notice, and is then checked once at the exact position.
`ribbon-paste-after-settlement` is a separate positive case. It commits the preedit with a real
`End` key, waits for a stable available state, then clicks Paste. It requires one read, one
insertion and exactly one revision.

Focus case: the external X11 window must actually hold X focus (`xdotool getwindowfocus`) and the
page must record a trusted window `blur`. The app must then regain X focus with a trusted window
`focus`, and editor focus must be restored. The syllable must appear exactly once when the IME
committed it. WebKitGTK delivered two `compositionend("하")` events on focus loss (documented in
`imeInput.ts`), and the app kept one. Tab switch: the trusted click must hit a document tab, the
commit must not arrive after the switch, and the Ctrl+V in the new document needs one positive
outcome. The text of each document is checked exactly.

Launcher cleanup is proven, not just recorded. The launcher is a child subreaper, so orphans of the
test command are reparented to it. It snapshots every descendant as (pid, start time), stops only
those, and exits non-zero (3) if any survive (`cleanup.json`: `proven`). A probe with a
`setsid`-detached `sleep` confirmed that leaks are found, stopped and reported.

## Observed native behaviour (WebKitGTK 2.54.1, IBus 1.5.33, ibus-hangul 1.5.5, GTK3 IM module)

- **Ctrl+C/X/V.** ibus-hangul flushes the preedit when it gets the Control press. The page sees
  `keydown(229)` → `input(deleteCompositionText)` → `compositionend("")` → `keydown(229)` →
  `input("하")` → `compositionend("하")`, and only then `keydown Control` and `keydown c|x|v`
  (not composing). The command therefore never sees an active preedit. Copy/Cut had no selection
  (the composition used it) and were refused (`selectionRequired`). Ctrl+V pasted once after the
  committed syllable (`…하CLIP-CTRL-V`), the expected order.
- **Ctrl+X over a selection.** Composing replaced the two selected characters, as usual for an IME.
  Cut did not run and the OS clipboard was not overwritten.
- **Ribbon Copy/Cut/Paste.** The GTK IBus module commits the preedit on button press, before
  `mousedown`. Usually the click arrives while that commit is still being applied and the command is
  refused (`앞선 편집을 반영하는 중`, pendingEdits) with no later replay. In one run (run3, HWPX
  ribbon Paste) the click arrived after the session had settled and Paste ran once. That is
  classified executed-after-settlement. Run3's text check stopped before that case because the old
  classifier treated every ribbon execution as unsafe; run4 and run5 use the corrected rule.
- **BackSpace cancellation.** `하` → `ㅎ` → `compositionend("")` followed by a Backspace keyup. HWP/HWPX
  release the wait for a final commit on that observed boundary. DOCX (WordCraft) does not take part
  in that boundary by design (`imeInput.ts`, T010) and stays fail-closed: a trusted ribbon Paste was
  refused with `입력 중인 글자 조합을 끝낸 뒤 다시 시도하세요`, with no read and no replay. The next
  key released it, and Paste then ran exactly once. The restriction is not permanent.
- **X11 focus away and back during preedit.** No clipboard read/write; the syllable appears at most
  once and nothing is lost.
- **Tab switch during preedit (pointer click on another document tab).** The syllable was committed
  once into the original document (HWPX revision +1). It never crossed into the newly active document.
  A Ctrl+V after the switch pasted once into the new document only (DOCX +1, HWP unchanged).

## Results

Initial acceptance (first classifier, app `dd49a0ce`):

| Run | App SHA-256 | Formats | Checks | Result |
|---|---|---|---|---|
| run1/run2 | `dd49a0ce…1870` | DOCX | 7 cases | PASS, then harness cancellation expectation corrected |
| run3 | same | all | 150 PASS, then classifier FAIL | ribbon executed-after-settlement misclassified (harness) |
| run4 | same | all | 174/174 | PASS |
| run5 | same | all | 174/174 | PASS (repetition; all ribbon commands blocked this run) |

After the change to `x11-clipboard-owner.py`, the existing plain clipboard acceptance
(`native-clipboard.py`) was rerun under the new launcher: 70/70 PASS (`target/clipboard-preedit/plain-regression`).

The app was rebuilt from HEAD 22813c9 (`npm run build`, Release RHWP assets verified,
`cargo build --bin geul --features tauri/custom-protocol`). The result was byte-identical
(`dd49a0ceec9f4bdfe1ac36649cdf614604f478f6317bbeb8d2ba925b06791870`). Evidence:
ignored `target/clipboard-preedit/`.

Limits: only Linux X11 + IBus (GTK3 IM module, default asynchronous mode) with ibus-hangul 2-beolsik.
Not covered: Wayland text-input, XIM, fcitx5, Windows TSF and macOS. Not covered: a delayed `compositionend`
or late commit that the platform did not actually produce. Ribbon outcome timing varies by run, and both
outcomes are accepted only under the classification above.

### Hardened acceptance (app `343b1456bd63f8c6f6292956639291177bdb35c91a9e3035fe5ecdaffd1aa455`)

| Run | Checks | Result | Note |
|---|---|---|---|
| h1 | 148/149 | FAIL | HWP text after cancel-Paste at wrong position (harness, below) |
| h4, h6 | — | FAIL | DOCX normal Cut partial / HWP Paste position: same harness cause |
| h7 | — | FAIL | strict rendered-state rule: DOCX Ctrl+V ran while render showed pendingEdits |
| h9 | 230/230 | PASS | cleanup proven, 10 owned processes, 0 survivors |
| h10 | 230/230 | PASS | repetition; cleanup proven |

Harness defect found and fixed: once the document text wrapped onto a second visual line, the
verification helper collapsed its selection with `End`, which only reaches the end of the current
visual line. Later insertions and the normal Cut then started mid-text. No text was lost or
duplicated; positions differed. The helper now reaches the true end with `Down`×6 + `End`, selects
with `Shift+Up`×6 + `Shift+Home`, and sends the command only after the final selection key's keyup
is observed and the command is available.

h9 outcomes, all with exact text: Ctrl+C/X refused `selectionRequired` (one HWP Ctrl+X over a
selection refused `pendingEdits`). Ctrl+V executed once in every format. Ribbon commands were
refused `pendingEdits`/`selectionRequired`, except the HWPX ribbon Paste, which settled first and
executed once. `ribbon-paste-after-settlement` executed once in all three formats. Saved bytes
reopened independently with the exact text.

Existing plain clipboard acceptance (`native-clipboard.py`) on the same app under the hardened
launcher: 70/70 PASS (`target/clipboard-hardening/plain`). Final status: the original
SetGlobalEngine blocker stays resolved, and the strengthened native preedit gate passes for DOCX/HWP/HWPX
in the Linux X11 + IBus (GTK3, asynchronous) + ibus-hangul 2-beolsik scope.
