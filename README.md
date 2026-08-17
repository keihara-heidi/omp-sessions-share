# omp-sessions-share

Private, live OMP sessions on your phone through Tailscale. Every interactive OMP session started or resumed on the host automatically starts native `/collab` and registers with the local dashboard.

OMP-only: upstream Pi does not provide `/collab`.

## Requirements

- macOS
- Bun 1.3.14 or newer
- OMP with native `/collab` support
- Tailscale installed, signed in, and available on the Mac and guest device

## Install

```bash
omp plugin install github:keihara-heidi/omp-sessions-share
```

Start OMP. On first use, accept the prompt to set up the local runtime; the session then appears on the dashboard automatically.

Setup creates:

- one loopback Bun daemon at `127.0.0.1:7466`
- one persistent macOS LaunchAgent
- one Tailscale Serve endpoint on HTTPS port `8443`
- one private config at `~/.omp/agent/omp-sessions-share.json` with mode `0600`
- PATH-first source-compatible launchers at `~/.local/bin/omp` and `~/.local/bin/omp-share`

No Vercel, Redis, cloud database, or central service.

## Use

1. Run or resume `omp`. Native `/collab` starts automatically and the session registers with the dashboard.
2. Run `/share` to reprint the dashboard URL and password or restart sharing. Run `/share stop` to stop dashboard sharing without terminating OMP or its collab session. Run `/collab` to display the active live-session link.
3. On a tailnet-connected phone, open the URL and enter the password.
4. Select a live session.
5. To start another session, expand a folder or repository and tap **Start** beside a worktree. The Mac opens a Terminal running OMP in that worktree. On a repository group, tap **New worktree** to create a sibling linked worktree with `git worktree` and start OMP there.
6. Tap the remove button on a session to hide it and SIGTERM that session's OMP process. The IDE or terminal app is not closed. If another live dashboard session shares the same process, only the dashboard row is removed.

Register a repository or directory before it has a live session:

```text
/share register [path]
```

The path defaults to the current session directory. A project folder containing multiple Git repositories registers each repository; a plain folder with no repositories registers as one folder.

Dashboard hierarchy:

```text
Folder / Repository
└── Worktree
    └── Sessions
```

Search is typo-tolerant and lets separate query terms match across repository names and paths, worktree or branch-like names, session titles, and session directories. super.engineering Shared Context branch groups and symlinked repository children are detected from their managed workspace paths.

Dashboard session changes arrive through an authenticated live event stream; no phone reload needed. A 15-second poll remains as a disconnect fallback.

Groups start collapsed. Launching is limited to worktrees advertised by a current live session.

The browser receives the collab link encrypted to a non-extractable RSA key generated on that device. The relay sees only OMP's existing end-to-end encrypted collab frames.

## Release policy

Every commit to `main` must bump the `package.json` version using semantic versioning.

## Repair setup

```bash
bun ~/.omp/plugins/node_modules/omp-sessions-share/setup/cli.ts
```

Setup is idempotent and retains existing secrets.

## Uninstall

Run runtime cleanup before removing the plugin:

```bash
bun ~/.omp/plugins/node_modules/omp-sessions-share/setup/cli.ts uninstall
omp plugin uninstall omp-sessions-share
```

## Security boundary

- Dashboard and relay listen on loopback only.
- Tailscale Serve is the only remote ingress.
- Tailnet membership and dashboard password are required.
- Host and cookie secrets never leave the Mac.
- Session state is memory-only and disappears when the daemon restarts.
- The public `my.omp.sh` origin serves only OMP's static browser client; session traffic connects to the private tailnet relay.

## License

MIT
