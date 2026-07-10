# TMU TUI Experience Prototype

Prototype for [Validate Queue Home and Picker Overlays with an interactive prototype](https://github.com/txchen/tmu/issues/39).

## Question

Does a rough interactive prototype make TMU's core journeys intuitive with the keyboard alone: restoring into Queue Home, starting a queued Track without autoplay, opening Global Search, adding a Track or Music Collection with Play Next, using Play Now, navigating Providers, manipulating Queue order, discovering commands, dismissing overlays without losing context, and adapting to different terminal sizes?

## Run

```sh
bun run prototype:tui-experience
```

## Validation Checklist

- Launch shows Queue Home with a restored Current Track and does not autoplay.
- Space resumes the Current Track; Queue selection stays independent.
- `o` opens Provider navigation; `/` opens the same Picker Overlay with search focused.
- `Enter` applies Play Next and does not start playback.
- `P` stands in for Play Now where the terminal cannot distinguish Shift+Enter.
- `l` inspects Albums and Playlists; `h` returns to the parent location.
- `J` / `K` reorder Queue rows while selection follows Track Identity.
- `?` help and `:` palette stack above the current context and dismiss back to it.
- `c` opens Clear Queue confirmation with Cancel selected.
- Resizing the terminal changes between wide, medium, and narrow layouts without changing the selected Track.

## Verdict

Human validation accepted the interaction direction: Queue Home plus transient Picker Overlays, keyboard-driven Queue shaping, discovery overlays, and dismissal behavior are directionally right.

The prototype layout is not the final visual design. The implementation-ready specification still needs a separate decision for final visual layout, responsive terminal tiers, and renderer-specific constraints.

The prototype is intentionally throwaway; keep only the decision captured in the issue resolution, then delete or absorb the useful parts.
