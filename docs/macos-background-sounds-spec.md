# macOS Background Sounds Control Specification

## Outcome

TMU can ship an optional Background Sounds Tab for candidate Macs without adding an npm dependency, persistent process, startup subprocess, or coupling to Provider, Playlist, Track, or Player behavior. The initial adapter is a bundled JavaScript for Automation (JXA) helper invoked as a short-lived `/usr/bin/osascript` subprocess. It dynamically bridges to Apple's private `HearingUtilities.framework` and fails closed when that contract is unavailable.

This is a best-effort private-API integration for TMU's current Node/npm CLI distribution. It is not a public Apple compatibility guarantee and must be revisited before any Mac App Store distribution.

## Product boundary

The Background Sounds Tab controls exactly three macOS-owned values:

- enabled state;
- selected immediately usable sound;
- normal independent volume.

It does not persist state, download Apple sound assets, change `mixesWithMedia` or `mediaVolume`, configure lock/sleep/timer/equalizer policies, or route audio through TMU's Player. Changing sound or volume never implicitly enables Background Sounds. When a desired sound is not immediately usable, the tab directs the user to macOS System Settings to download it and then refresh.

The healthy tab is labelled `Background`. The README describes it as a best-effort macOS integration; the healthy UI does not show a permanent private-API warning.

## Candidate gate and lifecycle

Startup speed is the dominant constraint. TMU must not launch `osascript` while starting.

At runtime composition, use an in-process platform/kernel-version check:

- non-Darwin or Darwin older than the macOS 26.5 baseline: no Background tab;
- macOS 26.5 or newer: create a candidate Background Sounds state and include the fourth tab for the whole session.

The candidate check is only a visibility gate. It does not claim that control works. The first transition into the Background tab starts the complete, non-mutating capability probe. Later transitions refresh through a full read. The `u` action also refreshes. TMU never polls Background Sounds, ties it to playback/render cadence, or subscribes to undocumented notifications.

The first lazy probe must validate, in one bounded helper invocation:

1. `/usr/bin/osascript` can execute the bundled JXA helper.
2. `HearingUtilities.framework` loads.
3. `HUComfortSoundsSettings.sharedInstance` resolves.
4. Every required getter and setter selector exists.
5. `comfortSoundsAvailable` is true.
6. Enabled state, selected sound, volume, and immediately usable sound inventory form a complete valid snapshot.
7. The helper emits exactly one supported versioned JSON response and exits successfully.

A failed first probe leaves the already-visible tab in `unavailable`, with a concise error and retry. It does not create a global dependency warning. A later failure leaves the last confirmed snapshot visible as stale and disables mutations until retry succeeds.

## Runtime seam

Define the product-facing boundary independently from JXA:

```ts
type BackgroundSoundOption = {
  id: string;
  label: string;
};

type BackgroundSoundsSnapshot = {
  enabled: boolean;
  sound: BackgroundSoundOption;
  sounds: readonly BackgroundSoundOption[];
  volumePercent: number; // finite integer, 0...100
};

type BackgroundSoundsFailureCode =
  | "unsupported-platform"
  | "helper-missing"
  | "framework-load"
  | "contract-mismatch"
  | "unavailable"
  | "timeout"
  | "helper-exit"
  | "malformed-response"
  | "invalid-snapshot"
  | "apply-mismatch"
  | "cancelled";

interface BackgroundSoundsControl {
  probe(signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  read(signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setEnabled(value: boolean, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setSound(id: string, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setVolume(percent: number, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
}
```

`createTmuRuntime` injects either the JXA adapter for candidate Macs or an unavailable adapter. `AppCoordinator` owns the session state and serialized operation tail. The adapter owns subprocess execution, protocol validation, private-framework details, timeouts, and cancellation. The Vue TUI renders state and emits intents; it never calls the helper directly.

Background Sounds state belongs in `AppState`, because it is macOS-owned operational state shared by coordinator and view. The selected row, pending volume draft, and any sound-list cursor belong in session-only `UI State`. Neither is added to TMU Config, App Preferences, or Last Playlist Snapshot.

## Session state machine

```text
hidden (non-candidate; no tab)

candidate --first entry/retry--> probing --valid snapshot--> ready
                                  |
                                  +--failure--> unavailable --retry--> probing

ready --read/set--> busy --confirmed snapshot--> ready
                    |
                    +--failure--> degraded --retry/read--> busy
```

- `candidate`: tab visible; no subprocess has run.
- `probing`: first probe in flight; bounded loading state.
- `unavailable`: no confirmed snapshot; controls disabled; error and retry visible.
- `ready`: confirmed snapshot; controls enabled.
- `busy`: last confirmed snapshot remains visible; conflicting mutations disabled.
- `degraded`: last confirmed snapshot marked stale; mutations disabled; error and retry visible.

Errors stay inside this state except for diagnostic logging. They never enter Player operations, stop or pause playback, or affect other tabs.

## Helper protocol and subprocess safety

Ship a small JXA source asset with the built package and locate it relative to the built ESM module. Add it to the existing `dist` output so the current npm `files` allow-list includes it. Add no runtime npm dependency.

Invoke `/usr/bin/osascript` directly with Node's `execFile` or equivalent argument-array API, never through a shell. The helper accepts only fixed commands and validated values:

```text
probe
read
set-enabled true|false
set-sound <JSON-encoded discovered id>
set-volume <integer 0...100>
```

It prints exactly one JSON envelope to stdout:

```json
{
  "protocolVersion": 1,
  "ok": true,
  "snapshot": {
    "enabled": true,
    "sound": { "id": "Rain", "label": "Rain" },
    "sounds": [{ "id": "Rain", "label": "Rain" }],
    "volumePercent": 60
  }
}
```

Failures use `ok: false`, a stable error code, and a bounded non-sensitive message. The Node adapter imposes bounded stdout/stderr, a short measured timeout, and `AbortSignal` cancellation. No command accepts arbitrary JavaScript, Objective-C selectors, paths, or shell content.

The helper validates the private contract dynamically. It discovers sound objects rather than hard-coding Apple's catalog, includes only sounds immediately usable without download, and maps opaque discovered ids back to those exact objects. It converts framework volume `0...1` to integer percent at the protocol boundary.

Every setter performs one mutation and then a full authoritative read. Success returns that confirmed snapshot, never merely the requested value. If normalized requested and confirmed values differ, return `apply-mismatch`. The helper never writes on probe/read or teardown.

## Operation ordering

Use one serialized coordinator queue for probe, reads, and setters. A refresh requested during a mutation runs afterward; repeated pending refreshes may collapse to one. Teardown cancels an in-flight child, clears any pending volume debounce, waits for the operation tail, and performs no restoring or final write.

Enabled and sound actions execute once and remain busy until confirmed. A sound change while disabled changes only the selected sound. Sound arrows move one entry in the latest confirmed usable inventory.

Volume changes use five-percentage-point steps. Rapid Left/Right presses update an explicitly marked pending draft and coalesce for approximately 150 ms; the coordinator then sends only the final normalized target. The confirmed value remains distinguishable while pending. The returned snapshot replaces both draft and confirmed display. A failure discards the draft and retains the prior confirmed value as stale.

## Tab interaction

Use the accepted single-column Settings-list layout:

```text
Background Sounds · macOS

Background Sounds   ● On
Sound               ‹ Rain ›
Volume              [■■■■■■····] 60%
State               Confirmed from macOS
```

The first three rows are the vertical focus path; State is non-focusable.

- `j/k` and Up/Down move focus.
- Left/Right adjust the focused sound or volume.
- `Enter` toggles or activates the focused control.
- `u` performs an explicit refresh.
- `?` opens Background-scoped Contextual Shortcut Help.
- `[`/`]` continue switching Top-Level Tabs.

On this tab, arrow keys are deliberately routed to the focused Background control before global arrow aliases. Global letter playback shortcuts remain intact: `h/l` still seek, `Space` still toggles play/pause, `+/-` still change Player volume, and `r` still toggles Repeat All. The footer documents only the most relevant Background actions; complete help documents both tab-local arrows and global playback letters.

Busy preserves values with an in-progress indicator. Unavailable shows no invented values. Degraded marks confirmed values stale and exposes retry. All layouts retain the global Now Playing Bar.

## Implementation slices

1. Add platform/version candidate detection and optional tab-list composition without a subprocess.
2. Add protocol types, snapshot validation, failure codes, unavailable fake, and JXA subprocess adapter.
3. Add the bundled JXA asset plus build/package copying and packaged smoke coverage.
4. Add App State/UI State and coordinator intents for lazy probe, refresh, enabled, sound, and debounced volume operations.
5. Extend tab routing, action registry, Settings-list rendering, footer, and shortcut help with the approved precedence rules.
6. Add automated contract, coordinator, rendering, failure, teardown, and packaging tests.
7. Run the mandatory reversible macOS 26.5 manual smoke test before release and document the tested build.

Each slice must keep Linux and non-candidate macOS behavior unchanged.

## Automated verification

Pure/unit tests:

- Darwin candidate comparison at, below, and above 26.5; Linux and malformed versions.
- Every missing private selector and `comfortSoundsAvailable=false` through fixture responses.
- Strict protocol version, JSON shape, volume, selected-sound, unique inventory, and bounded-output validation.
- Fixed executable/argument construction with no shell and safe opaque sound ids.
- Full failure-code mapping, timeout, cancellation, child exit, malformed output, and apply mismatch.
- Setter responses use confirmed re-read state and never optimistic state.
- Serialized ordering, refresh coalescing, volume debounce/coalescing, and teardown cancellation.
- Sound and volume mutations do not change enabled state.
- Candidate, probing, unavailable, ready, busy, degraded, and retry transitions.
- Background state is excluded from all persistence records and Player fingerprints/workflows.

TUI tests:

- Candidate machines show four cyclic tabs; other machines retain exactly three.
- Startup invokes no Background Sounds subprocess.
- First Background entry probes once; later entry reads.
- Settings-list focus, five-point volume steps, one-sound steps, pending/stale/error rendering, and retry.
- Arrow precedence is Background-local while `h/l`, `Space`, `+/-`, `r`, Now Playing Bar, and global quit remain operational.
- Narrow/medium/wide layouts and complete Contextual Shortcut Help.

Packaging tests:

- The npm tarball contains the JXA helper at the path resolved by built code.
- Packaged execution can locate the helper without source-tree files.
- Linux packaged smoke never invokes `osascript` and behaves as the existing three-tab app.

CI must not require a private framework or mutate host settings. Use fake adapters and fixture helper processes for deterministic coverage.

## Mandatory manual release verification

The feature must not ship until a tester on candidate macOS 26.5 or newer performs a reversible end-to-end test through the packaged artifact:

1. Record macOS build, CPU architecture, enabled state, selected sound, and volume.
2. Confirm TMU startup does not launch the helper and the tab appears.
3. Enter the tab and confirm the lazy probe/read.
4. Toggle enabled state and verify confirmed macOS state.
5. Select another already-usable sound and verify it without triggering a download.
6. Change volume and verify five-point/coalesced behavior.
7. While a TMU Track plays, repeat the operations and verify uninterrupted playback.
8. Change state in System Settings and verify re-entry and `u` refresh.
9. Exercise a controlled helper failure and successful retry.
10. Restore every original value in a `finally` path and verify restoration.

Record the tested macOS build in release evidence. Repeat the non-mutating compatibility probe for each macOS release TMU claims; private-interface compatibility evidence never replaces the runtime probe.

## Source decisions

- [Find a shippable macOS Background Sounds control mechanism](https://github.com/txchen/tmu/issues/101)
- [Define runtime capability detection and state synchronization](https://github.com/txchen/tmu/issues/102), including its superseding lazy-probe decision
- [Prototype the Background Sounds Tab interaction](https://github.com/txchen/tmu/issues/103)
- [macOS Background Sounds control research](./research/macos-background-sounds-control.md)
- [macOS Background Sounds capability and synchronization research](./research/macos-background-sounds-capability.md)
