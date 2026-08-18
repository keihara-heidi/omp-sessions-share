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
omp plugin install github:keihara-heidi/omp-sessions-share
```

Set up and start the dashboard from the terminal:

```bash
oss setup
oss start
```

Then start OMP normally. Each interactive session automatically starts native `/collab` and registers with the running dashboard.

Setup creates:

- one loopback Bun daemon at `127.0.0.1:7466`
- one persistent macOS LaunchAgent
- one Tailscale Serve endpoint on HTTPS port `8443`
- one private config at `~/.omp/agent/omp-sessions-share.json` with mode `0600`
- one private dashboard SQLite database at `~/.omp/agent/omp-sessions-share.sqlite` with mode `0600` and WAL (`-wal` / `-shm` sidecars also `0600`)
- PATH-first source-compatible launchers at `~/.local/bin/omp` and `~/.local/bin/omp-share`

If `~/.omp/agent/omp-sessions-share-locations.json` already exists, it is imported once into SQLite and left on disk unchanged so you can roll back.

No Vercel, Redis, cloud database, or central service.

## Use

```bash
oss help           # show every terminal command
oss start          # start dashboard, print health, and follow API requests
oss status         # show health checks and session counts
oss open           # open the dashboard
oss logs --follow  # follow sanitized API activity without starting it
oss stop           # stop dashboard sharing without stopping OMP
```

`oss start` remains attached to display sanitized requests. Press Ctrl-C to stop the display; the dashboard continues running in the background.

Start or resume OMP normally with `omp`. Dashboard lifecycle is not controlled from inside OMP; native `/collab` still displays the current live-session link.

On a tailnet-connected phone, open the dashboard URL and enter the password shown by `oss credentials`.

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

## Development conventions

- Fetch root server state once at the feature boundary and pass cohesive view models to rendering components. Do not add per-row queries for entities already present in the dashboard snapshot.
- Use query hooks for independently fetched and cached server state. Use variable-driven mutation hooks for operations; pass IDs or paths to the mutation instead of binding an entity when the hook is created.
- All dashboard count and status badges use `components/ds/badge.tsx`. Choose a semantic `variant` and an explicit `size`; do not rebuild badge geometry or colors at callsites.
- Consumers destructure and domain-alias only the mutation fields they use:

```ts
const { mutate: resumeSession, isPending: isResuming } =
  useResumeRecentSession();

resumeSession(recent.id);
```

- Extract `mutateAsync` instead when local work must await the operation. Do not extract both `mutate` and `mutateAsync` unless the component genuinely uses both.
- Prefer names such as `resumeSession`, `deleteWorktree`, and `isDeletingWorktree` over generic `mutation.mutate()` / `mutation.isPending` expressions.

## Release policy

Every commit to `main` must bump the `package.json` version using semantic versioning.

## Repair setup

```bash
oss setup
```

Setup is idempotent and retains existing secrets.

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
