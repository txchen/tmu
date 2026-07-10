# vue-tui feasibility for TMU's Low-Power TUI

Research for **Evaluate vue-tui for TMU's low-power interaction model**. Reviewed 2026-07-09 against vue-tui commit [`3e44c9a`](https://github.com/vuejs-ai/vue-tui/tree/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a). External claims below use project-owned source, documentation, or published package metadata.

## Question

Can vue-tui support TMU's Queue Home, stacked Picker Overlays, raw keyboard input including Vim chords and modifier keys, predictable focus and resize behavior, event-driven rendering with no steady-playback redraw loop by default, Bun/TypeScript packaging, and automated testing? If not, which TUI approach best satisfies those constraints and why?

## Decision

**Do not adopt vue-tui for TMU now.** Its runtime primitives are capable enough to express the intended interface, but its current public contract is too young and its supported toolchain is too far from TMU's proven Bun executable path for the architecture to be implementation-ready.

For the MVP, keep TMU's existing Bun/TypeScript terminal adapter and deepen it behind the current App State, UI State, App Coordinator, and `RenderScheduler` seams. Add a responsive layout model, explicit Picker Overlay stack, focus-return tokens, a context-aware action registry, and a real key-sequence parser as ordinary TypeScript domain/UI modules. This preserves the already-tested Low-Power TUI and packaging behavior while leaving the renderer replaceable.

Reconsider vue-tui after all three gates are true:

1. its runtime and testing APIs share a stable release line;
2. TMU has a passing Bun `--compile` proof for the full runtime, Yoga dependency, input, resize, and teardown paths; and
3. an interactive TMU prototype shows no render-cadence or terminal-correctness regression.

## Capability assessment

### Layout and Picker Overlays: capable primitives, application-owned behavior

vue-tui provides Yoga flexbox layout, reactive terminal dimensions, focus management, and absolute positioning. Those primitives can render Queue Home responsively and place one Picker Overlay above it. The project documents Yoga layout and its input/focus system in the [feature overview](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/README.md#L15-L19), and exposes reactive window size and focus controls in its [composable API](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/README.md#L137-L154).

The toolkit does not provide TMU's modal semantics. TMU would still need to own the ordered Picker Overlay stack, dimming/layer policy, focus trap, return-focus token, cancel/commit rules, selection restoration, and narrow-terminal fallback. That is acceptable architecturally, but it means vue-tui would replace terminal layout and rendering rather than solve the hard interaction model.

### Keyboard input: sufficient raw events; Vim chords remain TMU state

`useInput` exposes arrows, paging, Home/End, Return/Escape, Ctrl, Shift, Meta, Super, Hyper, lock states, and Kitty press/repeat/release metadata ([`Key` and `useInput`](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/runtime/src/composables/useInput.ts#L13-L117)). Active handlers acquire raw mode and detach cleanly with component scope ([raw-input lifecycle](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/runtime/src/composables/useInput.ts#L120-L144)).

That is enough for direct keys and for terminals that report modifiers distinctly. Multi-key Vim commands such as `gg` still require a TMU-owned key-sequence state machine with timeout/cancel rules. `Shift+Enter` must also have a documented fallback because legacy terminals do not always distinguish it from Enter; vue-tui's Kitty protocol support improves capable terminals but cannot change older terminal encodings.

### Focus and resize: good low-level behavior; TMU must define invariants

Components can register stable focus ids, activate/deactivate with surface state, and restore a specific id through the focus manager ([`useFocus`](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/runtime/src/composables/useFocus.ts#L14-L117), [`useFocusManager`](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/runtime/src/composables/useFocusManager.ts#L4-L21)). `useWindowSize` listens to terminal resize and updates reactive dimensions ([window-size implementation](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/runtime/src/composables/useWindowSize.ts#L20-L52)); the renderer cancels pending throttled work and commits synchronously on resize to avoid stale overlapping frames ([resize path](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/runtime/src/render.ts#L1444-L1487)).

TMU would still need to preserve selection by Track Identity, clamp scrolling after layout, trap focus inside the top Picker Overlay, and restore the prior focus on `Esc`. Those are product invariants and should not be delegated to a generic toolkit.

### Rendering cadence: event-driven foundation, but retain TMU's semantic scheduler

vue-tui schedules terminal commits after Vue update flushes and applies a leading/trailing throttle derived from `maxFps`; it does not require an idle tick for ordinary reactive views ([commit scheduler](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/runtime/src/scheduler.ts#L13-L128)). Animations are an opt-in composable rather than a base-loop requirement ([composable list](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/README.md#L137-L154)).

This is compatible with Low-Power TUI behavior only if TMU keeps its higher-level invalidation rules. Playback position events must remain suppressed or bounded by TMU Config before reaching reactive view state; duplicate semantic snapshots must remain coalesced; Provider and download progress must remain independently throttled. A renderer-wide `maxFps` ceiling is not a substitute for TMU's current `RenderScheduler` policy.

### Automated testing: designed well, published versions are currently incompatible

The testing package is intended to provide a fake TTY, input injection, frame assertions, resize, raw-mode inspection, teardown, and render-flush waiting ([testing API](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/testing/README.md#L10-L86)). Its own README nevertheless labels it early-stage and not recommended for production use ([testing maturity notice](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/testing/README.md#L1-L5)).

As published on 2026-07-09, `@vue-tui/runtime` is `0.1.1`, while `@vue-tui/testing` is `0.0.3`; the registry package for testing depends exactly on runtime `0.0.3` ([runtime package](https://www.npmjs.com/package/@vue-tui/runtime), [testing package](https://www.npmjs.com/package/@vue-tui/testing)). A clean latest-to-latest Bun install therefore contains two runtime copies. Reproducing the documented component test with a component imported from runtime `0.1.1` fails inside the testing harness's runtime `0.0.3` with `Unknown vue-tui element type: tui-text`. Pinning all packages backward would test an older runtime, not the candidate currently being evaluated.

This blocks an implementation-ready automated-testing story even though the underlying harness design is promising.

### Bun/TypeScript packaging: source mode works; TMU's executable path is unsupported

The runtime is ESM TypeScript output with Vue and Yoga dependencies, and a local smoke test successfully rendered a non-interactive component under Bun 1.3.14. That establishes basic Bun runtime compatibility, not deployable compatibility.

The project's declared engine is Node `>=22.18.0` ([runtime package metadata](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/runtime/package.json#L49-L82)). Its documented production workflow explicitly targets a self-contained **Node** module built with `tsdown`, keeping Node built-ins external ([production build](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/packages/vite/README.md#L50-L76)). The project does not document or test TMU's `bun build --compile --target=bun-linux-x64-baseline` path.

TMU already has tests around that Bun executable path and intentionally leaves mpv and yt-dlp as external helpers. Adopting vue-tui before a compiled Linux smoke proof would turn a settled delivery constraint into architecture risk.

### Maturity and maintenance risk: active, impressive, not settled

The upstream repository calls the runtime a **public beta** whose API is still stabilizing toward 1.0 and calls HMR experimental ([project status](https://github.com/vuejs-ai/vue-tui/blob/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a/README.md#L1-L6)). The current runtime is `0.1.1`, and the codebase has substantive source-level tests for input, resize, rendering, and terminal cleanup. This is evidence of serious active development, but the testing-package mismatch shows that the published ecosystem is not moving as one stable contract yet.

## Recommended TMU seam

The downstream architecture specification should preserve these boundaries regardless of renderer:

1. **UI model**: Queue Home layout tier, Picker Overlay stack, focus-return token, selected identities, viewport offsets, and key-sequence state.
2. **Action registry**: context, name, shortcut aliases, enabled predicate, and App Intent factory; shared by direct keys, Contextual Shortcut Help, and the Command Palette.
3. **Terminal adapter**: decoded input events, dimensions, full/region drawing, cursor lifecycle, and teardown. The existing implementation remains the MVP adapter.
4. **Semantic invalidation**: the existing `RenderScheduler` remains responsible for immediate meaningful changes, duplicate suppression, bounded progress, and zero idle redraws.
5. **Pure views**: Queue Home and each Picker Overlay render from App State plus UI State and can be snapshot-tested without a real TTY.

This keeps a later vue-tui or other renderer migration shallow: it replaces the terminal adapter and view composition, not Queue behavior, action meaning, focus policy, or low-power cadence.

## Sources and limitations

- [vue-tui repository at `3e44c9a`](https://github.com/vuejs-ai/vue-tui/tree/3e44c9a266e52ebeba2db669b4bb96521b9e2f3a)
- [Published `@vue-tui/runtime` metadata](https://www.npmjs.com/package/@vue-tui/runtime)
- [Published `@vue-tui/testing` metadata](https://www.npmjs.com/package/@vue-tui/testing)
- TMU's local `package.json`, `src/tui.ts`, `src/renderer.ts`, `tests/tui.test.ts`, and `tests/packaging-smoke.test.ts`

This was a source, package-metadata, and minimal compatibility review, not a full interactive prototype or performance benchmark. The conclusion is therefore about architecture readiness and evidence gaps, not measured CPU or battery superiority.
