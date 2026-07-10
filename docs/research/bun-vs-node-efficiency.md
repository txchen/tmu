# Bun vs Node.js Efficiency for TMU

Research for **whether TMU should switch its runtime from Bun to Node.js to reduce CPU use and energy consumption**. Reviewed 2026-07-10 against TMU's current source, Bun 1.3.11, and Node.js 24.13.0. External claims use runtime- or kernel-owned documentation; vendor performance claims are treated as claims, not independent measurements.

> Historical note: this comparison records the evidence used to choose Node. ADR-0002 and the current README supersede its pre-migration runtime descriptions.

## Conclusion

**The production playback benchmark favors Node.js for CPU efficiency.** Across three alternating complete 172-second runs, median controller CPU was 0.131 seconds under Node versus 1.028 seconds under Bun—about 87% less. Median controller-plus-mpv CPU was 2.291 seconds versus 3.214 seconds—about 29% less.

Median controller peak RSS was effectively even: 93,292 KiB under Node and 93,336 KiB under Bun. Energy was not measured because this machine exposes no powercap counter. CPU and memory are reported separately, and no direct energy claim follows from them.

TMU has subsequently decided to migrate the complete runtime to Node and benchmark the real TUI as validation rather than as a migration gate ([ADR 0002](../adr/0002-use-node-for-runtime-and-distribution.md)). The experiment establishes that Node is substantially more CPU-efficient for TMU's core mpv-control loop; it does not yet establish the size of the benefit once Vue TUI rendering, persistence, user input, and downloads are included.

The retained `npm run benchmark:playback` command requires Node. Bun was used only to record the migration comparison below from the same built production mpv-control implementation.

## Controlled playback experiment

Run on 2026-07-10 on `vibe97`, on AC power in balanced mode, with Bun 1.3.11, Node.js 24.13.0, mpv 0.41.0, and cached Track `mLW35YMzELE`. Runs alternated Bun/Node. Production `MpvPlayer` used Unix-socket IPC, one-second position polling, null audio, and natural EOF. Every retained run completed.

| Median metric (three runs) | Node.js | Bun | Node difference |
|---|---:|---:|---:|
| Controller CPU time | 0.130731 s | 1.028252 s | 87% lower |
| mpv CPU time | 2.160 s | 2.200 s | 2% lower |
| Controller + mpv CPU | 2.290731 s | 3.213720 s | 29% lower |
| Controller peak RSS | 93,292 KiB | 93,336 KiB | effectively even |
| mpv peak RSS | 58,144 KiB | 58,028 KiB | effectively even |
| Controller voluntary context switches | 434 | 14,821 | 97% lower |
| Controller involuntary context switches | 31 | 2,086 | 99% lower |
| mpv voluntary context switches | 4,465 | 4,481 | effectively even |
| mpv involuntary context switches | 188 | 159 | 18% higher |
| Elapsed time | 172.424 s | 172.408 s | effectively even |

Raw retained results follow. CPU values are seconds; RSS is KiB; context switches are voluntary/involuntary. `C` is controller and `M` is mpv. Controller metrics came from runtime process APIs and mpv metrics from Linux `/proc` at EOF. An extra pair with incomplete terminal capture was discarded.

| Order | Runtime | C user/system/total | M user/system/total | Combined | C RSS | M RSS | C ctx | M ctx | Elapsed | Complete |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 1 | Bun | .817042/.196678/1.013720 | 2.04/.16/2.20 | 3.213720 | 100268 | 58028 | 14714/2317 | 4506/159 | 172.408000 | yes |
| 2 | Node | .114655/.016076/.130731 | 1.99/.17/2.16 | 2.290731 | 100312 | 58080 | 431/31 | 4493/193 | 172.410599 | yes |
| 3 | Bun | .813336/.214916/1.028252 | 2.03/.17/2.20 | 3.228252 | 91596 | 58120 | 14821/2086 | 4481/239 | 172.425895 | yes |
| 4 | Node | .117924/.021114/.139038 | 2.02/.18/2.20 | 2.339038 | 92452 | 58188 | 434/35 | 4465/188 | 172.430924 | yes |
| 5 | Bun | .773273/.255334/1.028607 | 2.03/.14/2.17 | 3.198607 | 93336 | 57928 | 15099/2050 | 4456/108 | 172.392374 | yes |
| 6 | Node | .115233/.012401/.127634 | 1.97/.15/2.12 | 2.247634 | 93292 | 58144 | 436/15 | 4458/95 | 172.423539 | yes |

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

At the time of the experiment, production source used `Bun.spawn` and `Bun.sleep` for mpv startup and `Bun.write` for snapshot persistence. Tests and packaging used further runtime-specific terminal, subprocess, shell, and file APIs. Bun documents its child-process API independently ([Bun child processes](https://bun.com/docs/runtime/child-process)), while its compatibility page states that Node compatibility was incomplete for the evaluated version ([Bun Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat)). Running that pre-migration source under Node was therefore not a valid A/B comparison: the runtime-specific operations and packaging path first had to be adapted behind equivalent behavior.

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
