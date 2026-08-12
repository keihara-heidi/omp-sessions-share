#!/usr/bin/env bun
/**
 * CLI entry for first-run / repair setup.
 * Secrets are never accepted via argv. Only the dashboard password is printed.
 */
import { setupLocalRuntime, uninstallLocalRuntime } from "./install";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: omp-sessions-share [uninstall]

Without arguments: installs the local daemon, Tailscale Serve, config, and OMP launcher.
uninstall: removes persistent runtime state; run before "omp plugin uninstall omp-sessions-share".
macOS + running Tailscale required for setup. Secrets are generated locally and never passed on argv.
`);
  process.exit(0);
}

// Reject any attempt to feed secrets through argv.
const forbidden = process.argv.slice(2).filter((a) => {
  const lower = a.toLowerCase();
  return (
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.startsWith("--host") ||
    lower.startsWith("--cookie")
  );
});
if (forbidden.length > 0) {
  console.error("Refusing secret-like CLI flags. Setup generates secrets automatically.");
  process.exit(2);
}

if (process.argv[2] === "uninstall") {
  try {
    await uninstallLocalRuntime();
    console.log("omp-sessions-share local runtime removed.");
    process.exit(0);
  } catch (err) {
    console.error(`uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
if (process.argv.length > 2) {
  console.error("Unknown arguments. Use --help or uninstall.");
  process.exit(2);
}

try {
  const config = await setupLocalRuntime();
  console.log("omp-sessions-share setup complete.");
  console.log(`Dashboard (tailnet): ${config.publicOrigin}`);
  console.log(`Local origin:        ${config.localOrigin}`);
  console.log(`Config:              ~/.omp/agent/omp-sessions-share.json`);
  console.log(`Dashboard password:  ${config.dashboardPassword}`);
  console.log("Installed launchers: ~/.local/bin/omp and ~/.local/bin/omp-share");
  console.log("Restart Superconductor (or any already-open omp session) once so PATH picks up ~/.local/bin/omp.");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`setup failed: ${message}`);
  process.exit(1);
}
