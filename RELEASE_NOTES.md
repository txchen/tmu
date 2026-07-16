# TMU 0.4.0

TMU 0.4.0 switches completely to one long-lived per-user TMU Daemon with any number of TUI Clients. Before the first 0.4.0 launch, close every pre-0.4.0 TMU process so old and new releases cannot compete for mpv, the YouTube Cache, or persistence.

Running `tmu` is still the sole normal launch form. It connects to the existing TMU Daemon or starts one automatically. `q` and `Ctrl-C` Quit Client while shared playback and accepted downloads continue. `Ctrl-Q` shows the live impact before Shutdown Daemon. The only operational CLI subcommands are `tmu daemon status` and `tmu daemon stop [--force]`. TMU Config is daemon-owned and changes take effect only after Shutdown Daemon and a later `tmu` launch.

Each TUI Client owns its Viewed Playlist and other terminal-local UI State. The TMU Daemon owns the Playing Playlist and publishes shared playback, Playlists, Cache, and Download Pipeline state to every client. If the daemon exits unexpectedly, connected clients remain on a connection-lost surface; a later explicit `tmu` launch performs Daemon Recovery without autoplay.

## Snapshot migration and downgrade

On the first successful migration of a pre-0.4.0 Last Playlist Snapshot, TMU preserves the original beside it once as `last-playlists.json.pre-0.4.0`. The YouTube Cache is unchanged and is not copied. TMU keeps this backup but does not provide automatic downgrade.

To downgrade manually, first shut down the 0.4.0 daemon and close every TUI Client. Move the 0.4.0 `last-playlists.json` somewhere safe, then copy `last-playlists.json.pre-0.4.0` back to `last-playlists.json` before installing the older release. Keep both files until the older release has opened successfully. Paths follow `$XDG_STATE_HOME/tmu`, falling back to `~/.local/state/tmu`.

Linux and macOS use the same per-user Unix-socket architecture. WSL is supported through Linux behavior; native Windows remains unsupported.
