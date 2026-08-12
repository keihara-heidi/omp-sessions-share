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

Start OMP. First run asks permission to set up the local runtime. Accept, then open a new shell and run `omp` again.

Setup creates:

- one loopback Bun daemon at `127.0.0.1:7466`
- one persistent macOS LaunchAgent
- one Tailscale Serve endpoint on HTTPS port `8443`
- one private config at `~/.omp/agent/omp-sessions-share.json` with mode `0600`
- one source-compatible OMP launcher alias

No Vercel, Redis, cloud database, or central service.

## Use

1. Run `omp`. Native `/collab` starts automatically.
2. Run `/share` to display the tailnet dashboard QR, URL, and password.
3. On a tailnet-connected phone, open the URL and enter the password.
4. Select a live session.

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
