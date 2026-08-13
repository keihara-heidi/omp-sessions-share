# omp-sessions-share

Private, live OMP sessions on your phone through Tailscale. OMP sessions start native `/collab` automatically, appear in a local dashboard, and release an encrypted collab link after the dashboard password is accepted.

OMP-only: upstream Pi does not provide `/collab`.

## Requirements

- macOS
- Bun 1.3.14 or newer
- OMP 17.2.x
- Tailscale installed, signed in, and available on the Mac and guest device

## Install

```bash
omp plugin install github:keihara-heidi/omp-sessions-share
```

Start OMP. First run asks permission to set up the local runtime. Accept, then restart super.engineering once (or open a new shell) and run `omp` again.

Setup creates:

- one loopback Bun daemon at `127.0.0.1:7466`
- one persistent macOS LaunchAgent
- one Tailscale Serve endpoint on HTTPS port `8443`
- one private config at `~/.omp/agent/omp-sessions-share.json` with mode `0600`
- PATH-first source-compatible launchers at `~/.local/bin/omp` and `~/.local/bin/omp-share`

No Vercel, Redis, cloud database, or central service.

## Use

1. Run `omp`. Native `/collab` starts automatically.
2. Run `/share` to display the tailnet dashboard URL and password. Run `/collab` to display the active live-session link.
3. On a tailnet-connected phone, open the URL and enter the password.
4. Select a live session.
5. To start another session, expand a folder or repository and tap **Start** beside a worktree. The Mac opens a Terminal running OMP in that worktree. On a repository group, tap **New worktree** to create a worktree and start OMP there. Superconductor (`sc`) is used when the repo is a managed project; otherwise a sibling `git worktree` is created. Superconductor is not required.
6. Tap the remove button on a session to mark that live session inactive. This only removes it from the dashboard; its OMP history remains on the Mac.

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
