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

Classification (the observed native ordering decides, not an assumed one):

- **blocked** — no OS read/write happened.
- **executed-after-settlement** — the command's own trusted event (chord keydown or ribbon click)
  came after `compositionend` with no new composition between, was not composing, and the capture
  listener (which runs before the app handler) saw the session reporting Paste available.
- **UNSAFE** — any other execution. This fails the run.

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
