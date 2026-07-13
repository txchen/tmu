# macOS Background Sounds control

## Conclusion

**Doable on macOS Tahoe, with a runtime-gated private-framework adapter.** A normally installed TMU process can load Apple's private `HearingUtilities.framework` and use `HUComfortSoundsSettings` to read and change Background Sounds enabled state, selected sound, and independent volume. A read-only probe on macOS 26.5.1 succeeded as the logged-in user without root, Accessibility permission, UI scripting, or SIP changes.

This is not a public API contract. TMU should isolate it behind a small macOS helper, discover classes/selectors at runtime, and show the tab only after a non-mutating capability probe succeeds. The helper must fail closed if Apple removes or changes the private interface.

## What Apple supports publicly

Apple documents Background Sounds as a macOS Accessibility feature with controls for sound selection and volume. Apple also explicitly says it can play alongside other media and offers a separate “Use When Media Is Playing” volume. [Play background sounds on Mac](https://support.apple.com/guide/mac-help/mchl3061cdc6/mac) and [Play background sounds on AirPods](https://support.apple.com/guide/airpods/deva1bf8faad/web).

No Background Sounds API appears in Apple's published developer documentation. Searches of the Apple Developer documentation produce no relevant public framework/API, while Apple's user documentation directs users to System Settings and Shortcuts. Therefore there is no public Swift/Objective-C/JavaScript API on which TMU can base the required read/write control surface.

macOS Tahoe does add first-party Shortcuts actions. Apple says a shortcut can turn on Background Sounds, and documents `/usr/bin/shortcuts` as the supported command-line runner for shortcuts already in the user's collection. [Use Background Sounds to help with sleep, focus, and more](https://support.apple.com/en-us/109346) and [Run shortcuts from the command line](https://support.apple.com/guide/shortcuts-mac/apd455c82f02/mac).

The installed Apple `UASettingsShortcuts.appex` intent definition contains these Background Sounds actions:

- `ToggleBackgroundSounds`: enable, disable, or toggle;
- `SetBackgroundSound`: select one of 16 named sounds;
- `SetBackgroundSoundsVolume`: set volume from 0 through 100;
- `SetBackgroundSoundsTimer`: set the timer.

There is no get-state action for enabled state, selected sound, or volume. The `shortcuts` CLI only runs a shortcut already saved in the user's collection; it does not directly invoke an action or install/import a bundled shortcut. Consequently this supported route cannot meet TMU's source-of-truth/refresh requirement, and requiring users to manually create and maintain multiple shortcuts would not provide the proposed seamless tab. It remains a possible write-only fallback or user-directed workaround.

## Installed first-party interface

On the inspected Mac (`macOS 26.5.1`, build `25F80`, arm64), Apple ships:

- `/System/Library/PrivateFrameworks/HearingUtilities.framework`;
- private class `HUComfortSoundsSettings` with `+sharedInstance`;
- getters `comfortSoundsAvailable`, `comfortSoundsEnabled`, `selectedComfortSound`, `relativeVolume`, `mediaVolume`, and `mixesWithMedia`;
- setters `setComfortSoundsEnabled:`, `setSelectedComfortSound:`, `setRelativeVolume:`, `setMediaVolume:`, and `setMixesWithMedia:`;
- `HUComfortSound` fields including `name`, `localizedName`, `path`, `soundGroup`, and installation status.

These names come from Objective-C runtime metadata in Apple's installed framework and from Apple's installed Accessibility Settings and Shortcuts binaries. They are first-party implementation evidence, not a documented compatibility promise.

A non-mutating Swift runtime probe loaded the framework, obtained the singleton, and read:

```text
comfortSoundsAvailable  true
comfortSoundsEnabled    false
relativeVolume          0.6
mediaVolume             0.2
mixesWithMedia          true
selectedComfortSound    Rain
```

The same probe can be performed without compiling or installing a binary by using Apple's built-in JavaScript for Automation host (`osascript -l JavaScript`), loading the bundle, resolving the class with `NSClassFromString`, and reading the singleton. This returned the same values as an ordinary user process. No setter was invoked during this investigation.

## Reversible enablement proof

On 2026-07-13, a throwaway JXA prototype on macOS 26.5.1 (build 25F80, arm64) invoked `setComfortSoundsEnabled:` through a short-lived `/usr/bin/osascript` subprocess. It read the initial state as disabled, Rain, volume `0.6`; enabled Background Sounds; re-read enabled state in a separate subprocess; received human confirmation that Rain was audible; disabled Background Sounds; and independently re-read the restored disabled state. Sound and volume remained unchanged throughout. The prototype was then deleted.

This proves the proposed subprocess boundary and enabled-state setter end to end without root, Accessibility permission, UI scripting, or SIP changes. Sound-selection and volume setters still require the mandatory reversible release smoke test defined in the implementation specification.

The semantics visible in Settings indicate that `relativeVolume` is the normal Background Sounds volume and `mediaVolume` is the independent volume used while other media plays. TMU's requested slider should control `relativeVolume`; it should leave the user's existing `mixesWithMedia` and `mediaVolume` settings untouched so Background Sounds and TMU Tracks remain isolated.

## Why preferences alone are insufficient

The per-user `com.apple.ComfortSounds` preference domain exposes `comfortSoundsEnabled` and an `NSKeyedArchiver` blob named `ComfortSoundsSelectedSound`. The selected-sound blob contains private `HUComfortSound` and MobileAsset objects rather than a stable scalar identifier. The domain did not expose `relativeVolume` or `mediaVolume` on the inspected system.

Direct `defaults write` would therefore cover only part of the contract, bypass the framework's notifications/side effects, require decoding and recreating a private archive for sound changes, and provide no reliable volume control. TMU should not use the preference file as its adapter.

There is also no dedicated public executable for Background Sounds. The installed `heard` process is a private launch agent (`com.apple.accessibility.heard`) with private Mach services and Apple-only entitlements; TMU should neither invoke it directly nor depend on its XPC protocol.

## Recommended implementation boundary

Implement a tiny macOS-only helper invoked by the Node application. Prefer a compiled Objective-C/Swift helper for typed JSON I/O and predictable error handling; a bundled JXA script is viable for an initial implementation/prototype because it already proved private-framework access without extra distribution dependencies.

The helper should expose only:

```text
probe -> { available }
get   -> { enabled, sound: { name, localizedName }, volume }
set-enabled <boolean>
set-sound <stable discovered name>
set-volume <0...1>
```

At startup or when entering the potential fourth tab, `probe` should:

1. require Darwin/macOS;
2. locate and load `HearingUtilities.framework`;
3. resolve `HUComfortSoundsSettings`, `HUComfortSound`, `sharedInstance`, all required getters/setters, and `comfortSoundsAvailable`;
4. read the current state without mutation and validate types/ranges;
5. return unavailable on any exception, missing selector, invalid value, or unsupported sound inventory.

For sound selection, discover the installed sounds from Apple's framework/assets rather than hard-coding only an OS-version list. The Tahoe Shortcuts definition currently names Balanced Noise, Bright Noise, Dark Noise, Ocean, Rain, Stream, Babble, Steam, Airplane, Boat, Bus, Train, Rain on Roof, Quiet Night, Fire, and Night, but this inventory is private/version-dependent.

After every setter, re-read through `HUComfortSoundsSettings` and return the authoritative resulting state. On tab entry/focus, call `get` again so changes made in System Settings appear in TMU. Do not persist any Background Sound values in TMU.

## Shipping assessment and risks

This meets the agreed shippable bar technically: it needs no elevated privilege, TCC Accessibility grant, UI automation, or weakened system security; it can be isolated and positively capability-detected. It is suitable for a runtime-gated macOS feature, not an unconditional compatibility guarantee.

The material risk is private-API churn. Apple may rename classes/selectors, alter semantics, add signing/entitlement restrictions, or remove JXA bridging in a future update. Runtime probing limits the failure to omission of the tab. Tests should cover missing framework/class/selector, malformed values, failed setters, unavailable assets, and a simulated post-probe failure. A manual compatibility smoke test should run on each supported macOS release before TMU claims support.

If TMU distribution later targets the Mac App Store, this decision must be revisited: private API use is generally incompatible with App Review expectations. For the repository's current Node-distributed CLI model, there is no App Store review gate.

## Reproduction notes

The initial framework inspection was read-only; the later reversible enablement proof changed only enabled state and restored its original value. Useful first-party evidence paths on macOS 26.5.1:

- `/System/Library/PrivateFrameworks/HearingUtilities.framework`
- `/System/Library/PrivateFrameworks/UniversalAccess.framework/PlugIns/UASettingsShortcuts.appex/Contents/Resources/Base.lproj/Intents.intentdefinition`
- `/System/Library/ExtensionKit/Extensions/AccessibilitySettingsExtension.appex/Contents/MacOS/AccessibilitySettingsExtension`
- `/System/Library/LaunchAgents/com.apple.accessibility.heard.plist`
- `~/Library/Preferences/com.apple.ComfortSounds.plist`

The key non-mutating JXA probe shape was:

```javascript
ObjC.import("Foundation");
$.NSBundle.bundleWithPath(
  "/System/Library/PrivateFrameworks/HearingUtilities.framework"
).load;
const settings = $.NSClassFromString("HUComfortSoundsSettings").sharedInstance;
// Read settings.comfortSoundsAvailable, comfortSoundsEnabled,
// relativeVolume, mediaVolume, mixesWithMedia, and selectedComfortSound.name.
```
