---
status: accepted
---

# Use Node for Runtime and Distribution

TMU will replace Bun with Node.js 24 or newer for production, development, testing, and npm distribution. A controlled full-Track playback experiment found the Node mpv controller used about 88% less controller CPU and 22% less combined controller-plus-mpv CPU than the equivalent Bun controller, while using about 14% more controller memory; CPU efficiency and requiring users to install only Node and npm outweigh the memory increase and migration cost.

TMU will publish its own source as a prebuilt ESM bundle while keeping Node built-ins and declared npm runtime dependencies external. The package supports `npx tmu` and global npm installation, contains build output and user documentation rather than TypeScript source, and requires no TypeScript loader or compilation on the user's machine. npm and `package-lock.json` replace Bun throughout the repository; tsdown builds the package, Vitest runs tests, and node-pty provides development-only real-terminal testing.

Native Linux and macOS are supported, including WSL through Linux behavior; native Windows is outside scope. CI covers Node 24 and the latest major on Linux and Node 24 on macOS. Functional, build, and packaged-terminal checks are migration gates. A controlled local playback comparison will report median controller CPU over three alternating full-Track runs against the Bun baseline, together with memory and child-inclusive CPU, but performance does not block the Node migration; TMU makes no direct energy claim without hardware energy measurements.
