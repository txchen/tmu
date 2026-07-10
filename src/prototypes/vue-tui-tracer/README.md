# Development-only vue-tui tracer

This tracer proves the #48 contracts without changing TMU's production startup
or renderer. It intentionally imports vue-tui only from this prototype tree.

The exact pins in `package.json` and `bun.lock` are one compatible early-stage
line: Vue `3.5.39`, `@vue-tui/runtime` `0.0.3`, and `@vue-tui/testing` `0.0.3`.
The testing package depends exactly on runtime `0.0.3`; mixing it with the newer
runtime creates two renderer copies. The runtime is an early-stage ESM package
whose published distribution and Node-oriented terminal dependencies are run
directly from `node_modules` by Bun. This source-runtime assumption is accepted
only for the development tracer and is not a production packaging decision.

Run it in a terminal with `bun run tracer:vue-tui`. `q` quits Queue Home,
Ctrl-C requests graceful quit, `o` opens the Picker Overlay, and Space dispatches
Play/Pause/Resume through TMU's action registry.
