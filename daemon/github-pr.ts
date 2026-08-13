/** Direct GitHub PR readiness via the local `gh` CLI. */

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type {
  PullRequestAction,
  PullRequestReadiness,
  WorktreePullRequestStatus,
} from "../lib/contracts";
import { canonicalizePath, readGitBranch } from "./location";

const CACHE_TTL_MS = 30_000;
const PR_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "baseRefName",
  "headRefName",
  "isDraft",
  "mergeable",
  "reviewDecision",
  "statusCheckRollup",
].join(",");

const UNRESOLVED_THREADS_QUERY = [
  "query($owner:String!,$name:String!,$number:Int!){",
  "repository(owner:$owner,name:$name){",
  "pullRequest(number:$number){",
  "reviewThreads(first:100){nodes{isResolved}}",
  "}}}",
].join("");

export type PullRequestChecks = WorktreePullRequestStatus["pullRequest"] extends
  | null
  | infer P
  ? P extends { checks: infer C }
    ? C
    : never
  : never;

export type ParsedPullRequest = NonNullable<
  WorktreePullRequestStatus["pullRequest"]
> & {
  /** Internal only — used for repair prompts, not part of the public wire shape. */
  failedCheckNames: string[];
};

type GhRunResult = { stdout: string; stderr: string; code: number };

export type GhRunner = (
  bin: string,
  args: string[],
  cwd: string,
) => Promise<GhRunResult>;

export type GetWorktreePullRequestStatusOptions = {
  now?: number;
  resolveGhBin?: () => string | null;
  runGh?: GhRunner;
  readBranch?: (cwd: string) => string | undefined;
  canonicalize?: (input: string) => string;
  cacheTtlMs?: number;
  /** Test seam: bypass path existence checks. */
  assertWorktreePath?: (worktreePath: string) => string;
};

type CacheEntry = {
  value: WorktreePullRequestStatus;
  expiresAt: number;
};

const statusCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<WorktreePullRequestStatus>>();
/** Internal prompt evidence keyed by canonical worktree path. */
const failedCheckNamesByPath = new Map<string, string[]>();
/** Resolve `gh` from PATH and common Homebrew install locations. */
export function resolveGhBin(): string | null {
  const home = process.env.HOME?.trim() || homedir();
  const candidates = [
    "gh",
    join(home, "bin", "gh"),
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
  ];
  for (const bin of candidates) {
    try {
      const probe = Bun.spawnSync([bin, "--version"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (probe.exitCode === 0) return bin;
    } catch {
      // missing binary or not executable
    }
  }
  return null;
}

async function defaultRunGh(
  bin: string,
  args: string[],
  cwd: string,
): Promise<GhRunResult> {
  const proc = Bun.spawn([bin, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Never surface interactive auth prompts from the daemon.
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function isFailedCheckConclusion(value: string): boolean {
  switch (value) {
    case "FAILURE":
    case "TIMED_OUT":
    case "CANCELLED":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
    case "ERROR":
      return true;
    default:
      return false;
  }
}

function isPendingCheckStatus(value: string): boolean {
  switch (value) {
    case "QUEUED":
    case "IN_PROGRESS":
    case "PENDING":
    case "REQUESTED":
    case "WAITING":
    case "EXPECTED":
      return true;
    default:
      return false;
  }
}

/** Aggregate statusCheckRollup into public checks summary + failed names. */
export function summarizeStatusCheckRollup(rollup: unknown): {
  checks: PullRequestChecks;
  failedCheckNames: string[];
} {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return {
      checks: { state: "none", total: 0, failed: 0, pending: 0 },
      failedCheckNames: [],
    };
  }

  let failed = 0;
  let pending = 0;
  const failedCheckNames: string[] = [];

  for (const item of rollup) {
    const row = asRecord(item);
    if (!row) continue;

    const name =
      (typeof row.name === "string" && row.name) ||
      (typeof row.context === "string" && row.context) ||
      "check";

    const conclusion =
      typeof row.conclusion === "string" ? row.conclusion.toUpperCase() : "";
    const status =
      typeof row.status === "string" ? row.status.toUpperCase() : "";
    const state = typeof row.state === "string" ? row.state.toUpperCase() : "";

    // CheckRun path
    if (conclusion || status) {
      if (!conclusion || status !== "COMPLETED") {
        if (isPendingCheckStatus(status) || !conclusion) {
          pending += 1;
          continue;
        }
      }
      if (isFailedCheckConclusion(conclusion)) {
        failed += 1;
        failedCheckNames.push(name);
      }
      continue;
    }

    // StatusContext path
    if (state === "PENDING" || state === "EXPECTED") {
      pending += 1;
    } else if (state === "FAILURE" || state === "ERROR") {
      failed += 1;
      failedCheckNames.push(name);
    }
  }

  const total = rollup.length;
  let checkState: PullRequestChecks["state"] = "success";
  if (failed > 0) checkState = "failure";
  else if (pending > 0) checkState = "pending";
  else if (total === 0) checkState = "none";

  return {
    checks: { state: checkState, total, failed, pending },
    failedCheckNames,
  };
}

export function mapMergeable(
  value: unknown,
): "mergeable" | "conflicting" | "unknown" {
  if (typeof value !== "string") return "unknown";
  switch (value.toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

export function mapReviewDecision(
  value: unknown,
): "approved" | "changes_requested" | "review_required" | "none" {
  if (typeof value !== "string" || value.length === 0) return "none";
  switch (value.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

/**
 * Readiness precedence:
 * draft → conflicts → checks_failed → changes_requested →
 * unresolved comments (changes_requested) → checks_pending →
 * review_required → ready. unknown only for indeterminate data.
 */
export function computePullRequestReadiness(input: {
  isDraft: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown";
  reviewDecision:
    | "approved"
    | "changes_requested"
    | "review_required"
    | "none";
  checks: PullRequestChecks;
  unresolvedThreads: number;
}): PullRequestReadiness {
  if (input.isDraft) return "draft";
  if (input.mergeable === "conflicting") return "conflicts";
  if (input.checks.state === "failure") return "checks_failed";
  if (input.reviewDecision === "changes_requested") return "changes_requested";
  if (input.unresolvedThreads > 0) return "changes_requested";
  if (input.checks.state === "pending") return "checks_pending";
  if (input.reviewDecision === "review_required") return "review_required";
  if (input.mergeable === "unknown") return "unknown";
  return "ready";
}

/** Parse owner/name/number from a github.com pull request URL. */
export function parsePullRequestRepo(
  url: string,
): { owner: string; name: string; number: number } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    // /owner/repo/pull/123
    if (parts.length < 4 || parts[2] !== "pull") return null;
    const owner = parts[0];
    const name = parts[1];
    const number = Number(parts[3]);
    if (!owner || !name || !Number.isInteger(number) || number <= 0) return null;
    return { owner, name, number };
  } catch {
    return null;
  }
}

/** Count unresolved review threads from a GraphQL response body. */
export function parseUnresolvedThreadCount(payload: unknown): number {
  const root = asRecord(payload);
  if (!root) return 0;
  const data = asRecord(root.data) ?? root;
  const repository = asRecord(data.repository);
  const pullRequest = asRecord(repository?.pullRequest);
  const reviewThreads = asRecord(pullRequest?.reviewThreads);
  const nodes = reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return 0;
  let unresolved = 0;
  for (const node of nodes) {
    const row = asRecord(node);
    if (!row) continue;
    if (row.isResolved === false) unresolved += 1;
  }
  return unresolved;
}

/**
 * Parse `gh pr view --json` output into a structured PR.
 * Returns null when the payload is empty/not a PR object.
 * Throws on unexpected malformed JSON that looks like a PR but fails validation.
 */
export function parseGhPrView(
  stdout: string,
  unresolvedThreads = 0,
): ParsedPullRequest | null {
  const text = stdout.trim();
  if (!text || text === "null") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("malformed gh pr view JSON");
  }

  const o = asRecord(parsed);
  if (!o) return null;

  const number = o.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    // Empty object / no PR selected often surfaces as missing number.
    if (number === undefined || number === null) return null;
    throw new Error("malformed pull request number");
  }

  const title = typeof o.title === "string" ? o.title : "";
  const url = typeof o.url === "string" ? o.url : "";
  const baseBranch = typeof o.baseRefName === "string" ? o.baseRefName : "";
  const headBranch = typeof o.headRefName === "string" ? o.headRefName : "";
  if (!url || !baseBranch || !headBranch) {
    throw new Error("malformed pull request fields");
  }

  const isDraft = o.isDraft === true;
  const mergeable = mapMergeable(o.mergeable);
  const reviewDecision = mapReviewDecision(o.reviewDecision);
  const { checks, failedCheckNames } = summarizeStatusCheckRollup(
    o.statusCheckRollup,
  );
  const threads =
    typeof unresolvedThreads === "number" &&
    Number.isFinite(unresolvedThreads) &&
    unresolvedThreads >= 0
      ? Math.floor(unresolvedThreads)
      : 0;

  const readiness = computePullRequestReadiness({
    isDraft,
    mergeable,
    reviewDecision,
    checks,
    unresolvedThreads: threads,
  });

  return {
    number,
    title,
    url,
    baseBranch,
    headBranch,
    isDraft,
    readiness,
    mergeable,
    reviewDecision,
    checks,
    unresolvedThreads: threads,
    failedCheckNames,
  };
}

export function isPullRequestActionApplicable(
  status: WorktreePullRequestStatus,
  action: PullRequestAction,
): boolean {
  const pr = status.pullRequest;
  if (!pr) return false;
  switch (action) {
    case "fix_checks":
      return pr.checks.state === "failure" || pr.readiness === "checks_failed";
    case "resolve_comments":
      return pr.unresolvedThreads > 0;
    case "fix_conflicts":
      return pr.mergeable === "conflicting" || pr.readiness === "conflicts";
    case "address_review":
      return pr.reviewDecision === "changes_requested";
    default:
      return false;
  }
}

function actionSections(
  action: PullRequestAction,
  baseBranch: string,
): {
  title: string;
  goal: string;
  steps: string[];
  done: string[];
  reply: string;
  closing: string;
} {
  switch (action) {
    case "fix_checks":
      return {
        title: "Fix CI Failures",
        goal: "Get the review request back to a green or clearly improved CI state.",
        steps: [
          "Inspect the failing CI checks first (for example with `gh pr checks`, `gh run view <run-id> --log-failed`, `glab ci status`, or equivalent noninteractive logs) and identify the specific failing job or step.",
          "Determine the root cause before editing code.",
          "Implement the minimal fix needed for that root cause.",
          "Run the narrowest verification that proves the fix or meaningfully de-risks it.",
          "Commit the fix if changes were required.",
          "Push explicitly: run `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`; if it fails, run `git push --set-upstream origin HEAD`; otherwise run `git push`.",
        ],
        done: [
          "The CI failure has an identified root cause.",
          "Any required changes are committed and pushed to the review branch.",
          "You can report the verification you actually ran.",
        ],
        reply: "Summarize the failing check, root cause, fix, and verification.",
        closing: "Let's get CI green again.",
      };
    case "resolve_comments":
      return {
        title: "Address Review Threads",
        goal: "Evaluate every unresolved review thread against the code, then fix legitimate issues or decline with clear rationale. Do not clear threads without real evaluation.",
        steps: [
          "Inspect every unresolved review thread on the review request before responding. Comments can be wrong, outdated, or preference-only — verify each claim against the current code.",
          "For each thread, decide: fix (legitimate issue), or no code change (invalid/outdated/preference/out of scope). Only implement changes you independently agree with.",
          "Implement all required code changes first (minimal fixes only), then run relevant verification when practical.",
          "Commit the fix set with meaningful commit boundaries.",
          "Push explicitly: run `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`; if it fails, run `git push --set-upstream origin HEAD`; otherwise run `git push`.",
          "After the push, reply directly to every unresolved thread: for fixed threads, summarize what changed (with relevant files/functions/tests); for no-change threads, explain the code-level rationale with evidence.",
          "Resolve a thread only after its reply is posted and you are confident it is fully handled (real fix or evidence-backed decline). Leave uncertain threads open.",
          "Do not leave any unresolved thread without a direct reply, and do not resolve just to clear the queue.",
        ],
        done: [
          "Every unresolved review thread has a direct reply grounded in code evidence.",
          "Required code changes are committed and pushed before posting thread replies.",
          "No thread is marked resolved without either a concrete fix or a clear evidence-backed rationale.",
        ],
        reply: "Summarize each thread and whether it required a code change or rationale-only reply.",
        closing: "Evaluate every unresolved review comment against the code. Fix only legitimate issues; decline the rest with evidence. Do not resolve anything you have not actually evaluated.",
      };
    case "fix_conflicts":
      return {
        title: "Resolve Merge Conflicts",
        goal: `Resolve merge conflicts between this branch and \`origin/${baseBranch}\` without regressing the intended behavior.`,
        steps: [
          `Fetch the latest base branch: \`git fetch origin ${baseBranch}\`.`,
          `Merge the base branch into the current branch: \`git merge origin/${baseBranch}\`.`,
          "Inspect the conflicted files and the competing changes before editing.",
          "Resolve every conflict carefully, preserving the intended final behavior from both sides.",
          "Run `git diff --check` and verify no conflict markers remain.",
          "Commit the merge resolution.",
          "Push explicitly: run `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`; if it fails, run `git push --set-upstream origin HEAD`; otherwise run `git push`.",
        ],
        done: [
          "There are no conflicted files left.",
          "`git diff --check` is clean and no conflict markers remain.",
          "The resolved branch is pushed upstream.",
        ],
        reply: "Briefly summarize which files were resolved and confirm the push status.",
        closing: "Let's resolve conflicts and ship the update.",
      };
    case "address_review":
      return {
        title: "Fix Requested Changes",
        goal: "Evaluate the review request's requested-changes feedback against the code, then apply legitimate fixes or decline with clear technical rationale.",
        steps: [
          "Inspect the requested-changes review and related review request discussion before editing. Treat requests as claims — verify each against the current code.",
          "Identify every requested change and decide whether each requires a code update or a rationale-only reply. Only implement changes you independently agree with.",
          "Implement all required code changes first, keeping edits minimal and focused.",
          "Run relevant verification when practical.",
          "Commit the fix set with meaningful commit boundaries.",
          "Push explicitly: run `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`; if it fails, run `git push --set-upstream origin HEAD`; otherwise run `git push`.",
          "Reply to the requested-changes review or its relevant threads with what changed (or why not), including files/functions/tests when useful.",
          "Do not mark work complete until each requested change has either a confirmed fix or a clear code-level rationale.",
        ],
        done: [
          "Every requested change has been handled with a code fix or a direct evidence-backed rationale.",
          "Required code changes are committed and pushed.",
          "The final response identifies what was changed and what verification ran.",
        ],
        reply: "Summarize each requested change, the fix or rationale, and the verification.",
        closing: "Evaluate the requested changes against the code. Fix only legitimate ones; decline the rest with evidence.",
      };
  }
}

function evidenceLines(
  action: PullRequestAction,
  pr: NonNullable<WorktreePullRequestStatus["pullRequest"]>,
  failedCheckNames: string[] = [],
): string[] {
  const lines: string[] = [];
  switch (action) {
    case "fix_checks": {
      if (failedCheckNames.length > 0) {
        lines.push(`Failed checks: ${failedCheckNames.join(", ")}.`);
      } else {
        lines.push(
          `Checks: ${pr.checks.failed} failed of ${pr.checks.total} total.`,
        );
      }
      break;
    }
    case "resolve_comments":
      lines.push(`Unresolved review threads: ${pr.unresolvedThreads}.`);
      break;
    case "fix_conflicts":
      lines.push(`Mergeable state: ${pr.mergeable}.`);
      break;
    case "address_review":
      lines.push(`Review decision: ${pr.reviewDecision}.`);
      if (pr.unresolvedThreads > 0) {
        lines.push(`Unresolved review threads: ${pr.unresolvedThreads}.`);
      }
      break;
  }
  return lines;
}

/**
 * Build an OMP initial prompt for a PR repair action.
 * Caller must ensure the action is applicable.
 */
export function buildPullRequestTask(
  status: WorktreePullRequestStatus,
  action: PullRequestAction,
  options?: { failedCheckNames?: string[] },
): string {
  const pr = status.pullRequest;
  if (!pr) {
    throw new Error("pull request is required to build a repair task");
  }

  const cachedNames =
    failedCheckNamesByPath.get(status.worktreePath) ??
    failedCheckNamesByPath.get(canonicalizePath(status.worktreePath));
  const failedCheckNames = options?.failedCheckNames ?? cachedNames ?? [];

  const sections = actionSections(action, pr.baseBranch);
  const lines = [
    sections.title,
    "",
    "Goal:",
    sections.goal,
    "",
    "Context:",
    `PR: ${pr.url}`,
    `Number: #${pr.number}`,
    `Title: ${pr.title}`,
    `Base: ${pr.baseBranch}`,
    `Head: ${pr.headBranch}`,
    `Worktree: ${status.worktreePath}`,
    `Branch: ${status.branch || pr.headBranch}`,
    ...evidenceLines(action, pr, failedCheckNames),
    "",
    "Rules:",
    "- Use standard git plus the repository forge CLI for pull request or merge request operations: `gh` for GitHub, `glab` for GitLab.",
    "- Inspect the current repo and existing pull request or merge request state before choosing commit messages, titles, bodies, or replies.",
    "- Prefer repository conventions and existing templates when present.",
    "- Create meaningful commit boundaries: split unrelated changes into separate commits and keep each commit focused.",
    "- Use Conventional Commits for all new commits (`type(scope): summary` or `type: summary`; types: feat, fix, chore, docs, refactor, test, perf, build, ci, style).",
    "- Use explicit push logic: check upstream with `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`; if absent, run `git push --set-upstream origin HEAD`, else run `git push`.",
    "- Execute commands non-interactively and continue until the requested outcome is complete.",
    "- For multi-line pull request or merge request content, write it to a temp file or heredoc and pass the file to the forge CLI instead of inline multi-line body text.",
    "- If a command fails, resolve the issue and retry rather than stopping early.",
    "",
    "Steps:",
    ...sections.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Done:",
    ...sections.done.map((condition) => `- ${condition}`),
    "",
    "Reply:",
    sections.reply,
    "",
    sections.closing,
  ];
  return lines.join("\n");
}

function assertSafeWorktreePath(worktreePath: string): string {
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new Error("worktree path is required");
  }
  if (!isAbsolute(worktreePath)) {
    throw new Error("worktree path must be absolute");
  }
  if (worktreePath.includes("\0")) {
    throw new Error("worktree path is unsafe");
  }
  // Reject relative segments that could confuse callers even in absolute form.
  const normalized = resolve(worktreePath);
  try {
    accessSync(normalized, constants.F_OK);
  } catch {
    throw new Error("worktree path does not exist");
  }
  return canonicalizePath(normalized);
}

function nullStatus(
  worktreePath: string,
  branch: string,
  fetchedAt: string,
): WorktreePullRequestStatus {
  return {
    worktreePath,
    branch,
    fetchedAt,
    pullRequest: null,
  };
}


async function fetchUnresolvedThreads(
  runGh: GhRunner,
  bin: string,
  cwd: string,
  url: string,
  number: number,
): Promise<number> {
  const repo = parsePullRequestRepo(url);
  if (!repo) return 0;
  const result = await runGh(
    bin,
    [
      "api",
      "graphql",
      "-f",
      `query=${UNRESOLVED_THREADS_QUERY}`,
      "-F",
      `owner=${repo.owner}`,
      "-F",
      `name=${repo.name}`,
      "-F",
      `number=${number}`,
    ],
    cwd,
  );
  if (result.code !== 0) return 0;
  try {
    return parseUnresolvedThreadCount(JSON.parse(result.stdout) as unknown);
  } catch {
    return 0;
  }
}

async function loadStatus(
  worktreePath: string,
  canonicalPath: string,
  options: GetWorktreePullRequestStatusOptions,
): Promise<WorktreePullRequestStatus> {
  const now = options.now ?? Date.now();
  const fetchedAt = new Date(now).toISOString();
  const readBranch = options.readBranch ?? ((cwd: string) => readGitBranch(cwd));
  const branch = readBranch(canonicalPath) ?? "";
  const resolveBin = options.resolveGhBin ?? resolveGhBin;
  const runGh = options.runGh ?? defaultRunGh;

  const bin = resolveBin();
  if (!bin) {
    failedCheckNamesByPath.delete(canonicalPath);
    failedCheckNamesByPath.delete(worktreePath);
    return nullStatus(worktreePath, branch, fetchedAt);
  }

  const view = await runGh(
    bin,
    ["pr", "view", "--json", PR_JSON_FIELDS],
    canonicalPath,
  );

  if (view.code !== 0) {
    // Missing PR / unauthenticated / gh trouble → soft null, never leak stderr.
    failedCheckNamesByPath.delete(canonicalPath);
    failedCheckNamesByPath.delete(worktreePath);
    return nullStatus(worktreePath, branch, fetchedAt);
  }

  let draft = parseGhPrView(view.stdout, 0);
  if (!draft) {
    failedCheckNamesByPath.delete(canonicalPath);
    failedCheckNamesByPath.delete(worktreePath);
    return nullStatus(worktreePath, branch, fetchedAt);
  }

  const unresolvedThreads = await fetchUnresolvedThreads(
    runGh,
    bin,
    canonicalPath,
    draft.url,
    draft.number,
  );

  // Recompute readiness with thread count.
  draft = parseGhPrView(view.stdout, unresolvedThreads) ?? draft;

  const { failedCheckNames, ...pullRequest } = draft;
  if (failedCheckNames.length > 0) {
    failedCheckNamesByPath.set(canonicalPath, failedCheckNames);
    failedCheckNamesByPath.set(worktreePath, failedCheckNames);
  } else {
    failedCheckNamesByPath.delete(canonicalPath);
    failedCheckNamesByPath.delete(worktreePath);
  }

  return {
    worktreePath,
    branch,
    fetchedAt,
    pullRequest,
  };
}

/**
 * Discover PR readiness for a worktree path.
 * Caches successful and null results ~30s; dedupes in-flight requests.
 * Soft-fails to pullRequest:null when gh is missing/unauthenticated/no PR.
 */
export async function getWorktreePullRequestStatus(
  worktreePath: string,
  options: GetWorktreePullRequestStatusOptions = {},
): Promise<WorktreePullRequestStatus> {
  const assertPath = options.assertWorktreePath ?? assertSafeWorktreePath;
  const canonicalize = options.canonicalize ?? canonicalizePath;
  const canonicalPath = canonicalize(assertPath(worktreePath));
  const now = options.now ?? Date.now();
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;

  const cached = statusCache.get(canonicalPath);
  if (cached && cached.expiresAt > now) {
    return {
      ...cached.value,
      worktreePath,
    };
  }

  const existing = inflight.get(canonicalPath);
  if (existing) {
    const value = await existing;
    return { ...value, worktreePath };
  }

  const pending = loadStatus(worktreePath, canonicalPath, options)
    .then((value) => {
      statusCache.set(canonicalPath, {
        value,
        expiresAt: (options.now ?? Date.now()) + ttl,
      });
      return value;
    })
    .finally(() => {
      inflight.delete(canonicalPath);
    });

  inflight.set(canonicalPath, pending);
  return pending;
}

/** Test helper: drop cached PR status entries. */
export function clearPullRequestStatusCache(): void {
  statusCache.clear();
  inflight.clear();
  failedCheckNamesByPath.clear();
}
