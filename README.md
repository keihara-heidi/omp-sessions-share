# omp-sessions-share

Private, live OMP sessions on your phone through Tailscale. The dashboard is controlled from the terminal; OMP sessions connect to it automatically when it is running.

OMP-only: upstream Pi does not provide `/collab`.

## Requirements

- macOS
- Bun 1.3.14 or newer
- OMP with native `/collab` support
- Tailscale installed, signed in, and available on the Mac and guest device

## Install

```bash
omp plugin install github:keihara-heidi/omp-sessions-share#main
bun x --no-cache github:keihara-heidi/omp-sessions-share#main setup
oss start
```

The one-time `bun x` command performs initial setup from the latest commit and installs `oss` in `~/.local/bin`; lifecycle commands use `oss` afterward.

Then start OMP normally. Each interactive session automatically starts native `/collab` and registers with the running dashboard.

Setup creates:

- one loopback Bun daemon at `127.0.0.1:7466`
- one persistent macOS LaunchAgent
- one Tailscale Serve endpoint on HTTPS port `8443`
- one private config at `~/.omp/agent/omp-sessions-share.json` with mode `0600`
- one private dashboard SQLite database at `~/.omp/agent/omp-sessions-share.sqlite` with mode `0600` and WAL (`-wal` / `-shm` sidecars also `0600`)
- PATH-first launchers at `~/.local/bin/oss` and `~/.local/bin/omp-share`; setup creates `~/.local/bin/omp` only when that path is absent or already managed by this plugin

If `~/.omp/agent/omp-sessions-share-locations.json` already exists, it is imported once into SQLite and left on disk unchanged so you can roll back.

No Vercel, Redis, cloud database, or central service.

## Use

```bash
oss help           # show every terminal command
oss start          # start dashboard, print health, and follow API requests
oss stop           # stop dashboard sharing without stopping OMP
oss restart        # restart the dashboard daemon and Tailscale Serve
oss status         # show URL, service state, health, and session counts
oss open           # open the dashboard
oss credentials    # print the dashboard URL and password
oss logs --follow  # follow sanitized API activity without starting it
```

`oss start` remains attached to display sanitized requests. Press Ctrl-C to stop the display; the dashboard continues running in the background.

Start or resume OMP normally with `omp`. When the dashboard is running, each session starts native `/collab` automatically and appears under **Live**. Run `/collab` to display that session's current live link.

On a tailnet-connected phone, open the dashboard URL and enter the password shown by `oss credentials`.

From the dashboard:

1. **Sessions** joins Live sessions, marks them inactive, resumes exact prior conversations from Recent, and forgets Recent entries.
2. **Workspaces** starts blank sessions in remembered worktrees. Repository groups can create sibling linked worktrees; linked worktrees can be deleted when clean without deleting their branches.
3. Repository worktrees show pull-request readiness. Applicable actions start focused OMP repair sessions for conflicts, failed checks, requested changes, or unresolved review comments; ready pull requests can be merged directly.
4. **System** reports daemon, runtime, database, Tailscale, local-tool, and sleep-inhibitor health. Remediation remains terminal-driven.

Marking a Live session inactive SIGTERMs its OMP process only when no other live dashboard session shares that process. It does not close the containing terminal or IDE. Resumable inactive sessions move to Recent; resuming opens the exact session in its original worktree. The browser never receives the host session JSONL path.

Register a repository or directory before it has a live session:

```bash
oss register [path]
```

The path defaults to the current directory. A project folder containing multiple Git repositories registers each repository; a plain folder with no repositories registers as one folder.

The dashboard has three focused pages:

```text
Sessions (/)
├── Live
└── Recent

Workspaces (/workspaces/)
└── Folder / Repository
    └── Worktree
        ├── Live / Recent counts and compact session titles (tap Live to join)
        └── PR status and workspace actions

System (/system/)
├── Core
├── Connectivity
├── Tools
└── Power
```

Each page has typo-tolerant search using the same grouping rules. Sessions searches conversation titles and directories plus repository, worktree, and branch context. Workspaces searches repository, worktree, branch, path, and the compact session titles shown within expanded worktrees; Live rows are direct join shortcuts.

Dashboard session and location changes arrive as complete snapshots through one authenticated live event stream; no polling or phone reload is needed. EventSource reconnects automatically and receives a fresh snapshot.

System health is fetched independently and cached briefly by the daemon. **Refresh** requests a new snapshot without adding another dashboard event stream. Individual checks fail independently, so available diagnostics remain visible when one local dependency cannot be inspected.

Workspace groups start collapsed. Launching is limited to worktrees advertised by the dashboard’s remembered locations.

The browser receives the collab link encrypted to a non-extractable RSA key generated on that device. The relay sees only OMP's existing end-to-end encrypted collab frames.

## Repair setup

```bash
bun x --no-cache github:keihara-heidi/omp-sessions-share#main setup
```

Setup is idempotent, retains existing secrets, and also repairs a missing `oss` launcher.

## Update

```bash
oss update
```

Update upgrades the installed plugin and reruns idempotent setup so the copied daemon runtime and launchers match it.

## Uninstall

Run runtime cleanup before removing the plugin:

```bash
oss uninstall
omp plugin uninstall omp-sessions-share
```

Uninstall removes the local daemon, Tailscale Serve, launchers, share config, the dashboard SQLite database (including WAL/SHM sidecars), and the legacy locations JSON.

## Security boundary

- Dashboard and relay listen on loopback only.
- Tailscale Serve is the only remote ingress.
- Tailnet membership and dashboard password are required.
- Host and cookie secrets never leave the Mac.
- Live presence expires after 15 seconds without a host heartbeat. Remembered worktrees and Recent sessions persist in private SQLite; they do not disappear when the daemon restarts.
- The browser never receives the host session JSONL path.
- System health returns fixed summaries only. It never returns raw command output, exception text, process arguments, tokens, cookies, usernames, or private local paths.
- The public `my.omp.sh` origin serves only OMP's static browser client; session traffic connects to the private tailnet relay.

## License

MIT
