---
status: accepted
---

# Use a versioned same-user Unix socket

TUI Clients will communicate with the per-user TMU Daemon through a local Unix domain socket using length-prefixed JSON frames and an initial exchange of one integer protocol version, TMU version, and client identity. Client and daemon protocol integers must match exactly; incompatible changes increment the integer, with no major/minor negotiation or capability scheme. The socket lives under `$XDG_RUNTIME_DIR/tmu` when safe and available, otherwise under a user-owned `0700` runtime directory; socket and directory ownership and permissions constrain access to the current user. TMU will neither listen on TCP nor support cross-machine clients. This fits the supported macOS, Linux, and WSL scope while avoiding remote authentication and network exposure; explicit framing leaves snapshots and future message content independent of newline conventions.

Clients with equal protocol integers may connect across differing TMU versions and show a restart-to-upgrade notice rather than replacing the daemon automatically. An incompatible client shows a dedicated version error and cannot use the normal state protocol, but the public `tmu daemon status` and `tmu daemon stop` commands use a deliberately minimal, long-lived handshake so users can inspect and safely terminate an old daemon without finding its matching client version or killing a PID; no separate daemon-start command becomes part of the normal workflow.

Socket backpressure is isolated per connection: full snapshots coalesce to the latest revision, while non-droppable control messages have bounded buffering and disconnect a persistently slow client rather than blocking the daemon or another client.
