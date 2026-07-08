# Low-Power TUI Render Scheduler

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Implement the Low-Power TUI render scheduler so terminal redraws are event-driven and bounded. TMU should redraw immediately on user input and meaningful App State or UI State changes, use coarse playback-position ticks only while playing when needed, stop ticks while idle or paused, and throttle download or Provider progress updates.

Prototype context: the low-power TUI rendering prototype demonstrates the intended event-driven cadence and benchmark expectations.

## Acceptance criteria

- [ ] User input requests an immediate redraw.
- [ ] App State and UI State changes request redraws without requiring a fixed-FPS loop.
- [ ] Playing state enables coarse playback-position ticks no faster than the PRD cadence unless mpv events make ticks unnecessary.
- [ ] Idle and paused states stop playback-position ticks.
- [ ] Download and Provider progress updates are throttled for normal status display.
- [ ] The render scheduler is testable without asserting raw terminal escape output.
- [ ] Tests cover input redraw, state-change redraw, playing tick behavior, idle/paused tick shutdown, and progress throttling.

## Blocked by

- 15 - Walking Skeleton For Queue-First TMU
- 18 - mpv Player Adapter And Playback Controls
