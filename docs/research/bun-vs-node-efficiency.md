# Bun vs Node.js Efficiency for TMU

Research for **whether TMU should switch its runtime from Bun to Node.js to reduce CPU use and energy consumption**. Reviewed 2026-07-10 against TMU's current source, Bun 1.3.11, and Node.js 24.13.0. External claims use runtime- or kernel-owned documentation; vendor performance claims are treated as claims, not independent measurements.

## Conclusion

**The playback-controller experiment favors Node.js for CPU efficiency.** In a complete 172-second playback with the same track, mpv options, Unix-socket IPC, JSON messages, and one-second position polling, Node used 0.123 controller CPU-seconds versus Bun's 1.051 seconds—about 88% less. Including mpv, Node used 3.099 CPU-seconds versus Bun's 3.973 seconds—about 22% less total CPU. The gap is large enough to justify evaluating a complete Node port.

Node did use more controller memory: 52,952 KiB peak RSS versus Bun's 46,392 KiB, about 14% more. Energy was not measured directly because this machine exposes no powercap counter. Lower CPU work over the same elapsed time is evidence pointing toward lower energy use, but it is not a joule measurement.

TMU has subsequently decided to migrate the complete runtime to Node and benchmark the real TUI as validation rather than as a migration gate ([ADR 0002](../adr/0002-use-node-for-runtime-and-distribution.md)). The experiment establishes that Node is substantially more CPU-efficient for TMU's core mpv-control loop; it does not yet establish the size of the benefit once Vue TUI rendering, persistence, user input, and downloads are included.

TMU currently uses Bun-only production APIs (`Bun.spawn`, `Bun.sleep`, and `Bun.write`), so Node remains a real port rather than a runtime flag change.

## Controlled playback experiment

Run on 2026-07-10 with Bun 1.3.11, Node.js 24.13.0, mpv 0.41.0, and the same 172.241-second local WebM Track. Both controllers came from the same throwaway source and performed the same operations: spawn mpv, connect to its Unix socket, send a `get_property time-pos` JSON request once per second, consume replies, and wait for natural EOF. mpv used null audio output to remove audio-device variability. Both runs completed naturally in about 172.5 seconds and sent 171 polls.

| Metric | Node.js | Bun | Node difference |
|---|---:|---:|---:|
| Controller CPU time | 0.123 s | 1.051 s | 88% lower |
| Controller user CPU | 0.108 s | 0.758 s | 86% lower |
| Controller system CPU | 0.015 s | 0.293 s | 95% lower |
| Controller + mpv CPU | 3.099 s | 3.973 s | 22% lower |
| Controller peak RSS | 52,952 KiB | 46,392 KiB | 14% higher |
| Voluntary context switches | 419 | 15,563 | 97% lower |
| Involuntary context switches | 85 | 2,912 | 97% lower |

The runs were performed in reverse order after discarding an initial instrumented pair whose in-process `/proc` sampling introduced runtime-dependent filesystem overhead. In the retained pair, controller metrics came from `process.cpuUsage()` and `process.resourceUsage()` after playback; Bash accounted for controller-plus-child CPU externally. This is one paired experiment, not a statistical benchmark, but the controller CPU gap is much larger than normal run-to-run noise would plausibly explain.

## What the available evidence establishes

### Published runtime claims do not answer the energy question

Bun's runtime documentation says it uses JavaScriptCore and “usually starts and runs faster than V8,” including a Linux startup claim, but provides no corresponding CPU-time or energy-per-operation result ([Bun runtime](https://bun.com/docs/runtime)). Bun's published SQLite comparison likewise concerns query throughput, not TMU's workload, idle CPU, or joules ([Bun 1.0 SQLite claim and benchmark link](https://bun.com/blog/bun-v1.0), [benchmark source](https://github.com/oven-sh/bun/tree/main/bench/sqlite)). These results cannot establish which runtime consumes less energy in TMU.

Bun's `--smol` option explicitly trades performance for lower memory by running garbage collection more often ([Bun runtime](https://bun.com/docs/runtime)). Lower memory is therefore not automatically lower CPU use or lower energy.

No official controlled Node-versus-Bun measurement of idle CPU or energy for an event-driven terminal application was found. That absence motivated the repository-specific experiment above; unrelated HTTP, startup, or database throughput benchmarks still do not answer TMU's question.

### TMU's steady-state workload is intentionally small

The current `StatePublicationGate` schedules trailing work only after observed changes and explicitly creates neither an idle loop nor a recurring playback timer (`src/state-publication.ts`). Playback-position polling exists only while playback is active and schedules one query per configured interval, which defaults to one second (`src/player.ts`). Media playback and download are delegated to the long-lived `mpv` process and `yt-dlp`, respectively. Consequently, system-wide consumption during playback or download includes work that changing the JavaScript runtime does not remove.

This makes three scenarios relevant, in order:

1. idle TUI with no playback;
2. cached playback with `mpv` and TMU's one-second IPC query;
3. a `yt-dlp` download alongside playback.

Startup microbenchmarks are low-value for a long-running player; steady-state CPU time and whole-system energy in those scenarios are the decision metrics.

### A Node evaluation requires a real port

Production source uses `Bun.spawn` and `Bun.sleep` for mpv startup and `Bun.write` for snapshot persistence. Tests and packaging use further Bun-specific terminal, subprocess, shell, and file APIs. Bun documents its child-process API independently ([Bun child processes](https://bun.com/docs/runtime/child-process)), while its compatibility page states that Node compatibility is still incomplete ([Bun Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat)). Running the same source under Node is therefore not a valid A/B comparison: first the runtime-specific operations and packaging path must be adapted behind equivalent behavior.

## Follow-up full-application measurement

Build equivalent full Bun and Node TMU executables, then alternate repeated runs on the same machine with the same terminal dimensions, cache, Track, `mpv`/`yt-dlp` versions, power mode, and warm-up. Record:

- JavaScript-process user and system CPU time;
- child-process CPU time separately;
- wakeups/context switches and peak RSS; and
- whole-system or package energy for each complete scenario.

Node defines `process.cpuUsage()` as user and system CPU time in microseconds, and `process.resourceUsage()` exposes CPU time, maximum RSS, filesystem operations, and context switches ([Node.js process API](https://nodejs.org/api/process.html#processcpuusagepreviousvalue), [resource usage](https://nodejs.org/api/process.html#processresourceusage)). Bun's subprocess API exposes child CPU time and max RSS through `resourceUsage()` ([Bun child processes](https://bun.com/docs/runtime/child-process)). On supported Linux hardware, the kernel powercap interface exposes energy counters such as `energy_uj`, including Intel RAPL zones ([Linux power capping framework](https://www.kernel.org/doc/html/latest/power/powercap/powercap.html)). This environment exposes no powercap energy counter, so it cannot produce a credible local joule comparison.

The full-application comparison will quantify whether the controller result carries through the TUI, but it does not decide whether TMU migrates. Event frequency, rendering, polling, and external-tool behavior remain important regardless of runtime.

## Sources and limitations

- [Bun runtime documentation](https://bun.com/docs/runtime)
- [Bun child-process documentation](https://bun.com/docs/runtime/child-process)
- [Bun Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Node.js process API](https://nodejs.org/api/process.html)
- [Linux power capping framework](https://www.kernel.org/doc/html/latest/power/powercap/powercap.html)
- TMU's local `package.json`, `src/state-publication.ts`, `src/player.ts`, `src/youtube-url-download.ts`, `src/snapshot.ts`, and packaging tests

This includes an empirical CPU and memory comparison of equivalent minimal mpv controllers, but not a full-TMU comparison or direct energy benchmark. Direct energy measurement remains blocked by the absence of a usable system energy counter in this environment.
