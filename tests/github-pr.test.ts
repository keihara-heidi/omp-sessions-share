import { afterEach, describe, expect, test } from "bun:test";

import type {
  PullRequestAction,
  WorktreePullRequestStatus,
} from "../lib/contracts";
import {
  buildPullRequestTask,
  clearPullRequestStatusCache,
  computePullRequestReadiness,
  getWorktreePullRequestStatus,
  isPullRequestActionApplicable,
  mapMergeable,
  mapReviewDecision,
  parseGhPrView,
  parsePullRequestRepo,
  parseUnresolvedThreadCount,
  summarizeStatusCheckRollup,
  type GhRunner,
} from "../daemon/github-pr";

afterEach(() => {
  clearPullRequestStatusCache();
});

function basePrJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: "Fix dashboards",
    url: "https://github.com/acme/app/pull/42",
    baseRefName: "main",
    headRefName: "feat/dashboards",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "",
    statusCheckRollup: [],
    ...overrides,
  });
}

function statusWith(
  pr: NonNullable<WorktreePullRequestStatus["pullRequest"]>,
): WorktreePullRequestStatus {
  return {
    worktreePath: "/tmp/worktree",
    branch: "feat/dashboards",
    fetchedAt: "2026-08-13T00:00:00.000Z",
    pullRequest: pr,
  };
}

describe("summarizeStatusCheckRollup", () => {
  test("counts check runs and status contexts", () => {
    const { checks, failedCheckNames } = summarizeStatusCheckRollup([
      {
        __typename: "CheckRun",
        name: "lint",
        status: "COMPLETED",
        conclusion: "FAILURE",
      },
      {
        __typename: "CheckRun",
        name: "unit",
        status: "IN_PROGRESS",
        conclusion: null,
      },
      {
        __typename: "StatusContext",
        context: "deploy/preview",
        state: "SUCCESS",
      },
      {
        __typename: "StatusContext",
        context: "security",
        state: "ERROR",
      },
    ]);

    expect(checks).toEqual({
      state: "failure",
      total: 4,
      failed: 2,
      pending: 1,
    });
    expect(failedCheckNames).toEqual(["lint", "security"]);
  });

  test("empty rollup is none", () => {
    expect(summarizeStatusCheckRollup([])).toEqual({
      checks: { state: "none", total: 0, failed: 0, pending: 0 },
      failedCheckNames: [],
    });
  });
});

describe("computePullRequestReadiness", () => {
  const readyChecks = { state: "success" as const, total: 1, failed: 0, pending: 0 };
  const failedChecks = { state: "failure" as const, total: 2, failed: 1, pending: 0 };
  const pendingChecks = { state: "pending" as const, total: 2, failed: 0, pending: 1 };
  const noneChecks = { state: "none" as const, total: 0, failed: 0, pending: 0 };

  test("follows contract precedence", () => {
    expect(
      computePullRequestReadiness({
        isDraft: true,
        mergeable: "conflicting",
        reviewDecision: "changes_requested",
        checks: failedChecks,
        unresolvedThreads: 3,
      }),
    ).toBe("draft");

    expect(
      computePullRequestReadiness({
        isDraft: false,
        mergeable: "conflicting",
        reviewDecision: "changes_requested",
        checks: failedChecks,
        unresolvedThreads: 3,
      }),
    ).toBe("conflicts");

    expect(
      computePullRequestReadiness({
        isDraft: false,
        mergeable: "mergeable",
        reviewDecision: "changes_requested",
        checks: failedChecks,
        unresolvedThreads: 3,
      }),
    ).toBe("checks_failed");

    expect(
      computePullRequestReadiness({
        isDraft: false,
        mergeable: "mergeable",
        reviewDecision: "changes_requested",
        checks: readyChecks,
        unresolvedThreads: 0,
      }),
    ).toBe("changes_requested");

    expect(
      computePullRequestReadiness({
        isDraft: false,
        mergeable: "mergeable",
        reviewDecision: "none",
        checks: readyChecks,
        unresolvedThreads: 2,
      }),
    ).toBe("changes_requested");

    expect(
      computePullRequestReadiness({
        isDraft: false,
        mergeable: "mergeable",
        reviewDecision: "review_required",
        checks: pendingChecks,
        unresolvedThreads: 0,
      }),
    ).toBe("checks_pending");

    expect(
      computePullRequestReadiness({
        isDraft: false,
        mergeable: "mergeable",
        reviewDecision: "review_required",
        checks: readyChecks,
        unresolvedThreads: 0,
      }),
    ).toBe("review_required");

    expect(
      computePullRequestReadiness({
        isDraft: false,
        mergeable: "mergeable",
        reviewDecision: "approved",
        checks: readyChecks,
        unresolvedThreads: 0,
      }),
    ).toBe("ready");

    expect(
      computePullRequestReadiness({
        isDraft: false,
        mergeable: "unknown",
        reviewDecision: "none",
        checks: noneChecks,
        unresolvedThreads: 0,
      }),
    ).toBe("unknown");
  });
});

describe("parse helpers", () => {
  test("maps mergeable and review decision enums", () => {
    expect(mapMergeable("MERGEABLE")).toBe("mergeable");
    expect(mapMergeable("CONFLICTING")).toBe("conflicting");
    expect(mapMergeable("UNKNOWN")).toBe("unknown");
    expect(mapMergeable(null)).toBe("unknown");

    expect(mapReviewDecision("APPROVED")).toBe("approved");
    expect(mapReviewDecision("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(mapReviewDecision("REVIEW_REQUIRED")).toBe("review_required");
    expect(mapReviewDecision("")).toBe("none");
    expect(mapReviewDecision(undefined)).toBe("none");
  });

  test("parses PR repo from url", () => {
    expect(parsePullRequestRepo("https://github.com/acme/app/pull/42")).toEqual({
      owner: "acme",
      name: "app",
      number: 42,
    });
    expect(parsePullRequestRepo("https://example.com/acme/app/pull/42")).toBeNull();
    expect(parsePullRequestRepo("not-a-url")).toBeNull();
  });

  test("counts unresolved review threads", () => {
    expect(
      parseUnresolvedThreadCount({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { isResolved: true },
                  { isResolved: false },
                  { isResolved: false },
                ],
              },
            },
          },
        },
      }),
    ).toBe(2);
    expect(parseUnresolvedThreadCount({})).toBe(0);
  });

  test("parseGhPrView builds readiness and strips nothing essential", () => {
    const pr = parseGhPrView(
      basePrJson({
        isDraft: false,
        mergeable: "CONFLICTING",
        reviewDecision: "REVIEW_REQUIRED",
        statusCheckRollup: [
          {
            name: "ci",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
      }),
      0,
    );
    expect(pr).not.toBeNull();
    expect(pr?.readiness).toBe("conflicts");
    expect(pr?.mergeable).toBe("conflicting");
    expect(pr?.reviewDecision).toBe("review_required");
    expect(pr?.checks.state).toBe("success");
    expect(pr?.failedCheckNames).toEqual([]);
  });

  test("parseGhPrView returns null for empty payload", () => {
    expect(parseGhPrView("")).toBeNull();
    expect(parseGhPrView("null")).toBeNull();
    expect(parseGhPrView("{}")).toBeNull();
  });

  test("parseGhPrView throws on malformed JSON", () => {
    expect(() => parseGhPrView("{not-json")).toThrow("malformed gh pr view JSON");
  });
});

describe("isPullRequestActionApplicable", () => {
  test("gates each action on evidence", () => {
    const failed = statusWith({
      number: 1,
      title: "t",
      url: "https://github.com/a/b/pull/1",
      baseBranch: "main",
      headBranch: "f",
      isDraft: false,
      readiness: "checks_failed",
      mergeable: "mergeable",
      reviewDecision: "none",
      checks: { state: "failure", total: 2, failed: 1, pending: 0 },
      unresolvedThreads: 0,
    });
    expect(isPullRequestActionApplicable(failed, "fix_checks")).toBe(true);
    expect(isPullRequestActionApplicable(failed, "fix_conflicts")).toBe(false);

    const comments = statusWith({
      ...failed.pullRequest!,
      readiness: "changes_requested",
      checks: { state: "success", total: 1, failed: 0, pending: 0 },
      unresolvedThreads: 3,
    });
    expect(isPullRequestActionApplicable(comments, "resolve_comments")).toBe(true);
    expect(isPullRequestActionApplicable(comments, "address_review")).toBe(false);

    const review = statusWith({
      ...failed.pullRequest!,
      readiness: "changes_requested",
      reviewDecision: "changes_requested",
      checks: { state: "success", total: 1, failed: 0, pending: 0 },
      unresolvedThreads: 0,
    });
    expect(isPullRequestActionApplicable(review, "address_review")).toBe(true);
    expect(isPullRequestActionApplicable(review, "resolve_comments")).toBe(false);

    const conflicts = statusWith({
      ...failed.pullRequest!,
      readiness: "conflicts",
      mergeable: "conflicting",
      checks: { state: "success", total: 0, failed: 0, pending: 0 },
    });
    expect(isPullRequestActionApplicable(conflicts, "fix_conflicts")).toBe(true);

    const none: WorktreePullRequestStatus = {
      worktreePath: "/tmp/x",
      branch: "main",
      fetchedAt: "2026-08-13T00:00:00.000Z",
      pullRequest: null,
    };
    for (const action of [
      "fix_checks",
      "resolve_comments",
      "fix_conflicts",
      "address_review",
    ] as PullRequestAction[]) {
      expect(isPullRequestActionApplicable(none, action)).toBe(false);
    }
  });
});

describe("buildPullRequestTask", () => {
  test("includes PR identity and action-specific evidence", () => {
    const status = statusWith({
      number: 42,
      title: "Fix dashboards",
      url: "https://github.com/acme/app/pull/42",
      baseBranch: "main",
      headBranch: "feat/dashboards",
      isDraft: false,
      readiness: "checks_failed",
      mergeable: "mergeable",
      reviewDecision: "none",
      checks: { state: "failure", total: 3, failed: 2, pending: 0 },
      unresolvedThreads: 0,
    });

    const prompt = buildPullRequestTask(status, "fix_checks", {
      failedCheckNames: ["lint", "typecheck"],
    });

    expect(prompt).toContain("Fix failing checks on PR #42.");
    expect(prompt).toContain("PR: https://github.com/acme/app/pull/42");
    expect(prompt).toContain("Number: #42");
    expect(prompt).toContain("Base: main");
    expect(prompt).toContain("Head: feat/dashboards");
    expect(prompt).toContain("Failed checks: lint, typecheck.");
    expect(prompt).toContain("Inspect the current worktree and PR state");
    expect(prompt).toContain("Do not merge or push unless the user explicitly asks.");
    expect(prompt).not.toContain("token");
    expect(prompt).not.toContain("gh auth");

    const comments = buildPullRequestTask(
      statusWith({
        ...status.pullRequest!,
        readiness: "changes_requested",
        unresolvedThreads: 4,
        checks: { state: "success", total: 1, failed: 0, pending: 0 },
      }),
      "resolve_comments",
    );
    expect(comments).toContain("Unresolved review threads: 4.");
    expect(comments).toContain("Resolve review comments on PR #42.");

    const conflicts = buildPullRequestTask(
      statusWith({
        ...status.pullRequest!,
        readiness: "conflicts",
        mergeable: "conflicting",
      }),
      "fix_conflicts",
    );
    expect(conflicts).toContain("Mergeable state: conflicting.");
  });

  test("throws without a pull request", () => {
    expect(() =>
      buildPullRequestTask(
        {
          worktreePath: "/tmp/x",
          branch: "main",
          fetchedAt: "2026-08-13T00:00:00.000Z",
          pullRequest: null,
        },
        "fix_checks",
      ),
    ).toThrow("pull request is required");
  });
});

describe("getWorktreePullRequestStatus", () => {
  test("returns null PR when gh is unavailable", async () => {
    const status = await getWorktreePullRequestStatus("/tmp/demo", {
      now: 1_000,
      resolveGhBin: () => null,
      readBranch: () => "feat/x",
      assertWorktreePath: (p) => p,
      canonicalize: (p) => p,
    });
    expect(status).toEqual({
      worktreePath: "/tmp/demo",
      branch: "feat/x",
      fetchedAt: new Date(1_000).toISOString(),
      pullRequest: null,
    });
  });

  test("returns null PR when no pull request exists", async () => {
    const runGh: GhRunner = async (_bin, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          code: 1,
          stdout: "",
          stderr: "no pull requests found for branch \"feat/x\"",
        };
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };

    const status = await getWorktreePullRequestStatus("/tmp/demo", {
      now: 2_000,
      resolveGhBin: () => "/opt/homebrew/bin/gh",
      runGh,
      readBranch: () => "feat/x",
      assertWorktreePath: (p) => p,
      canonicalize: (p) => p,
    });
    expect(status.pullRequest).toBeNull();
    expect(status.branch).toBe("feat/x");
  });

  test("returns null PR when gh is not authenticated", async () => {
    const status = await getWorktreePullRequestStatus("/tmp/demo", {
      now: 3_000,
      resolveGhBin: () => "gh",
      runGh: async () => ({
        code: 4,
        stdout: "",
        stderr: "To get started with GitHub CLI, please run: gh auth login",
      }),
      readBranch: () => "main",
      assertWorktreePath: (p) => p,
      canonicalize: (p) => p,
    });
    expect(status.pullRequest).toBeNull();
  });

  test("parses PR view + unresolved threads without network", async () => {
    const runGh: GhRunner = async (_bin, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: basePrJson({
            statusCheckRollup: [
              {
                name: "lint",
                status: "COMPLETED",
                conclusion: "FAILURE",
              },
              {
                name: "unit",
                status: "COMPLETED",
                conclusion: "SUCCESS",
              },
            ],
            reviewDecision: "CHANGES_REQUESTED",
          }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        expect(args).toContain("query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}");
        expect(args).toContain("owner=acme");
        expect(args).toContain("name=app");
        expect(args).toContain("number=42");
        // argv array only — no shell-interpolated blob
        expect(args.every((a) => !a.includes(" && "))).toBe(true);
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [{ isResolved: false }, { isResolved: true }],
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };

    const status = await getWorktreePullRequestStatus("/tmp/repo-a", {
      now: 4_000,
      resolveGhBin: () => "gh",
      runGh,
      readBranch: () => "feat/dashboards",
      assertWorktreePath: (p) => p,
      canonicalize: (p) => p,
    });

    expect(status.pullRequest).not.toBeNull();
    expect(status.pullRequest?.number).toBe(42);
    expect(status.pullRequest?.readiness).toBe("checks_failed");
    expect(status.pullRequest?.checks).toEqual({
      state: "failure",
      total: 2,
      failed: 1,
      pending: 0,
    });
    expect(status.pullRequest?.unresolvedThreads).toBe(1);
    expect(status.pullRequest?.reviewDecision).toBe("changes_requested");
    // public contract must not leak internal failed names
    expect(
      Object.prototype.hasOwnProperty.call(status.pullRequest, "failedCheckNames"),
    ).toBe(false);

    const prompt = buildPullRequestTask(status, "fix_checks");
    expect(prompt).toContain("Failed checks: lint.");
  });

  test("caches by canonical path and dedupes in-flight loads", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runGh: GhRunner = async (_bin, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        calls += 1;
        await gate;
        return { code: 0, stdout: basePrJson(), stderr: "" };
      }
      if (args[0] === "api") {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: { reviewThreads: { nodes: [] } },
              },
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };

    const opts = {
      now: 5_000,
      resolveGhBin: () => "gh",
      runGh,
      readBranch: () => "feat/dashboards",
      assertWorktreePath: (p: string) => p,
      canonicalize: () => "/canonical/repo",
      cacheTtlMs: 30_000,
    };

    const p1 = getWorktreePullRequestStatus("/tmp/alias-a", opts);
    const p2 = getWorktreePullRequestStatus("/tmp/alias-b", opts);
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(a.pullRequest?.number).toBe(42);
    expect(b.pullRequest?.number).toBe(42);
    expect(a.worktreePath).toBe("/tmp/alias-a");
    expect(b.worktreePath).toBe("/tmp/alias-b");

    // Cache hit — no additional gh calls.
    const c = await getWorktreePullRequestStatus("/tmp/alias-c", {
      ...opts,
      now: 5_000 + 10_000,
    });
    expect(calls).toBe(1);
    expect(c.pullRequest?.number).toBe(42);

    // Expired cache refetches.
    const d = await getWorktreePullRequestStatus("/tmp/alias-d", {
      ...opts,
      now: 5_000 + 31_000,
    });
    expect(calls).toBe(2);
    expect(d.pullRequest?.number).toBe(42);
  });

  test("throws on relative or empty paths", async () => {
    await expect(getWorktreePullRequestStatus("relative/path")).rejects.toThrow(
      "absolute",
    );
    await expect(getWorktreePullRequestStatus("")).rejects.toThrow("required");
  });
});
