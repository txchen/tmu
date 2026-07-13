# macOS Background Sounds capability and synchronization

## Superseding startup decision

Later product grilling made launch speed the dominant constraint and superseded this note's original recommendation to complete the private-framework probe before mounting the TUI. Startup now performs only a fast in-process macOS/version candidate check. A candidate session includes the Background tab, and the first transition into it starts the authoritative `osascript` capability probe and full read. Probe failure keeps the tab visible in an unavailable state with retry. All validation, serialization, set-then-re-read, no-polling, and typed-failure guidance below remains in force after that lazy probe begins.

## Decision

TMU should treat the OS/version check as a fast **candidate gate** and the private-framework probe as the authoritative capability decision. On candidate macOS versions, show the fourth tab for the lifetime of that TMU process without invoking `osascript` during startup. Probe lazily on first entry. Once shown, keep the tab visible even if probing or a later operation fails; show an unavailable or stale state, disable mutations, and offer retry. Never persist Background Sounds state in TMU.

The authoritative synchronization rule is **read on tab entry, set then re-read**. Refresh whenever the user transitions into the Background Sounds tab, on an explicit refresh command, and after every setter. Serialize adapter calls, apply a timeout, and do no idle or playback-cadence polling. This makes changes performed in System Settings visible when the tab is revisited without adding a permanent wakeup source.

No stable notification should be part of the contract. Apple publishes application/workspace lifecycle notifications, but no public Background Sounds state-change notification. Private notification names or implementation details found in binaries would carry the same churn risk as the private framework while still needing a reconciliation read, so they add complexity without replacing any required read.

## Capability contract

Put the private API behind a macOS-only adapter owned by the runtime composition layer. The Node application should depend on an interface such as:

```ts
type BackgroundSoundsSnapshot = {
  enabled: boolean;
  sound: { id: string; label: string };
  sounds: readonly { id: string; label: string }[];
  volume: number; // finite, 0...1
};

interface BackgroundSoundsControl {
  probe(signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  read(signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setEnabled(value: boolean, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setSound(id: string, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setVolume(value: number, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
}
```

The production implementation may be a small compiled Swift/Objective-C executable or a bundled JXA helper. In either case Node should invoke it directly with `execFile`, not through a shell, use bounded stdout/stderr and a short timeout, and support cancellation during teardown. Node documents that `execFile` does not spawn a shell by default and accepts both timeouts and `AbortSignal`s: [Node.js child process documentation](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).

### Positive lazy capability probe

The probe succeeds only when all of the following hold in one helper invocation:

1. The startup candidate gate already established Darwin and the configured minimum candidate macOS version.
2. `NSBundle` can load `/System/Library/PrivateFrameworks/HearingUtilities.framework`. Apple defines a bundle as the representation of framework code/resources and documents dynamic bundle loading: [Apple `NSBundle`](https://developer.apple.com/documentation/foundation/bundle).
3. `NSClassFromString("HUComfortSoundsSettings")`, `sharedInstance`, and the settings object resolve.
4. The settings object responds to every required selector: `comfortSoundsAvailable`, `comfortSoundsEnabled`, `setComfortSoundsEnabled:`, `selectedComfortSound`, `setSelectedComfortSound:`, `relativeVolume`, and `setRelativeVolume:`.
5. `comfortSoundsAvailable` is true.
6. A full read produces valid values: booleans are booleans; volume is finite and in `0...1`; selected sound has a nonempty stable identifier and label; and the selectable inventory is nonempty, has unique nonempty identifiers, and contains the selected sound.
7. The helper emits exactly one versioned JSON response and exits successfully within the timeout.

The test on macOS 26.5.1 confirmed steps 2–5 and a valid read without mutation. The installed framework responded to all seven named selectors and returned `available=true`, `enabled=false`, `relativeVolume=0.6`, and selected sound `Rain`. This is first-party runtime metadata, not a public compatibility promise. Apple documents the user-visible enabled, sound, and volume controls, including that Background Sounds can continue alongside other media: [Play background sounds on Mac](https://support.apple.com/guide/mac-help/mchl3061cdc6/mac).

A framework path, macOS version, class presence, or partial getter set alone is not a positive probe. In particular, sound inventory discovery and the ability to map each exposed identifier back to the framework's sound object are mandatory. If the adapter cannot do that on a particular release, the feature is unavailable there rather than partly enabled.

The probe must not call a setter, download an asset, write a preference, start audio, or change the user's selected sound. It tests structural write capability with `respondsToSelector:` and semantic capability with reads only.

## Authoritative operations

All reads and writes go through `HUComfortSoundsSettings`; neither UI state nor `com.apple.ComfortSounds` is authoritative.

- `read`: obtain enabled state, selected sound, independent `relativeVolume`, and current selectable inventory in one helper invocation; validate and return one snapshot.
- `setEnabled`: validate a JSON boolean, invoke `setComfortSoundsEnabled:`, then perform the same full read and return it.
- `setSound`: accept only an identifier in the latest confirmed inventory, resolve it to the adapter's discovered `HUComfortSound`, invoke `setSelectedComfortSound:`, then perform the full read.
- `setVolume`: reject non-finite/out-of-range input (the UI may clamp before calling), invoke `setRelativeVolume:`, then perform the full read.

Each successful setter response is the re-read snapshot, not the requested value. If the resulting enabled/sound/volume value does not equal the normalized request, report an `apply-mismatch` failure and retain the returned snapshot only as diagnostic data. Do not optimistically publish a requested value before confirmation. Leave `mixesWithMedia` and `mediaVolume` untouched: TMU controls Background Sounds' normal independent volume and does not alter the user's media-mixing policy.

Use a single-flight queue in the coordinator/adapter boundary. A refresh arriving during a mutation should run after it; repeated pending refreshes may coalesce to one. Disable or debounce the initiating control until its operation settles. This prevents an older read from overwriting a newer confirmed setter result.

## Refresh and lifecycle integration

TMU currently has three tabs in `UiState`, central tab cycling in `adjacentTab`, runtime construction in `createTmuRuntime`, coordinator startup/teardown, and no application-focus lifecycle event. Integrate as follows:

1. `createTmuRuntime` performs a fast in-process platform/version candidate check and injects a Darwin adapter or a non-candidate unavailable adapter without launching a subprocess.
2. `AppCoordinator.start()` does not invoke the Background Sounds adapter, preserving the existing launch path.
3. Extend central tab navigation to include Background Sounds for candidate sessions. The first transition into it runs `probe`; later transitions run `read` and may show the last confirmed snapshot while refresh is in flight.
4. Add an explicit refresh key/action in the tab. This covers a user who changes System Settings while leaving the TMU tab selected.
5. Every mutation uses set-and-re-read and publishes the returned snapshot through normal coordinator state-change notification.
6. `teardown()` aborts an in-flight helper and waits for the serialized operation tail. It never writes a final value.

Do not attach reads to playback ticks, terminal resize, render/publication cadence, or arbitrary keyboard input. Do not add a repeating timer. An optional future native helper could observe the terminal/app becoming active, but TMU is a terminal Node process rather than an `NSApplication`, so AppKit's `didBecomeActiveNotification` is not presently an honest lifecycle seam. Apple says that notification is posted after an AppKit app becomes active: [Apple `NSApplication.didBecomeActiveNotification`](https://developer.apple.com/documentation/appkit/nsapplication/didbecomeactivenotification). `NSWorkspace` also provides application/session activation notifications, but those indicate lifecycle, not Background Sounds changes: [Apple `NSWorkspace.didActivateApplicationNotification`](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification), [Apple `sessionDidBecomeActiveNotification`](https://developer.apple.com/documentation/appkit/nsworkspace/sessiondidbecomeactivenotification).

## UI state machine and degradation

Keep capability visibility separate from operation health:

```text
candidate --first tab entry--> probing --success--> ready
                                  | failure
                                  v
                    unavailable (tab remains with retry)

ready --read/set--> busy --confirmed snapshot--> ready
  ^                  |
  | retry succeeds   | timeout, malformed result, helper exit,
  |                  | missing selector, invalid snapshot, mismatch
  +----- degraded <--+
```

- **candidate**: startup platform/version gate passed; the tab is visible but has not launched `osascript`.
- **probing**: first tab entry or retry; the tab shows bounded loading state.
- **unavailable**: the lazy probe failed or returned `available=false`; keep the tab visible, disable mutations, show an actionable message, and allow retry. Normal TMU playback remains unaffected.
- **ready**: a confirmed snapshot is rendered and controls are enabled.
- **busy**: preserve the last confirmed snapshot, show progress, and serialize controls.
- **degraded**: keep the session-sticky tab visible, mark the last confirmed snapshot stale, disable mutations, show a concise actionable error, and allow explicit retry or leave/re-enter refresh.

A successful full read from degraded returns to ready. A failure does not mutate or clear the last confirmed snapshot. Errors should be typed at the adapter boundary (`unsupported-platform`, `framework-load`, `contract-mismatch`, `unavailable`, `timeout`, `helper-exit`, `malformed-response`, `invalid-snapshot`, `apply-mismatch`) so the UI can distinguish “not supported” at startup from “control failed; retry” after exposure. Never route these failures into player operations or stop/pause TMU audio.

## Compatibility policy

Use the inspected and release-tested macOS baseline as a cheap candidate gate, but do not claim working capability merely because the version matches. The inspected framework's bundle metadata reports a macOS 26.5 minimum, while a private framework can change independently in any update. The lazy complete runtime probe remains the authoritative control decision.

Maintain a compatibility matrix in tests/release verification for each macOS release TMU claims, but treat it as evidence, not the runtime gate. Unit tests should cover non-Darwin, every missing selector, `available=false`, malformed JSON, timeout/cancellation, invalid ranges/inventory, setter mismatch, serialized read/write order, degraded retry, and session-sticky visibility. A manual release smoke test should run the non-mutating probe and separately exercise each setter with informed consent, restoring the tester's values afterward.

This policy allows TMU itself to keep supporting Linux and older macOS while exposing the fourth tab only on machines where the complete control contract works now. Mac App Store distribution remains out of scope because the mechanism is private API.

## Local evidence inspected

- `docs/research/macos-background-sounds-control.md`, the prior feasibility decision and read-only reproduction.
- `/System/Library/PrivateFrameworks/HearingUtilities.framework/Versions/A/Resources/Info.plist` and Objective-C runtime responses on macOS 26.5.1.
- `src/app.ts`, `src/coordinator.ts`, `src/main.ts`, `src/domain.ts`, `src/ui-state.ts`, `src/vue-tui/component.ts`, and `src/dependencies.ts` for TMU composition, lifecycle, tab routing, publication, and existing timed child-process conventions.
- `docs/adr/0002-use-node-for-runtime-and-distribution.md` for the supported Node/npm, Linux, and macOS runtime boundary.

The original framework inspection and capability probe were read-only. A later throwaway JXA prototype successfully toggled enabled state on, confirmed it through an independent read and human listening check, then restored the original off state. Sound and volume setters remain unexercised pending the mandatory reversible release smoke test.
