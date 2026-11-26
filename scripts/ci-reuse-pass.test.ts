import { describe, expect, test } from "vitest";
// @ts-expect-error The reuse script is a plain .mjs script with no type declarations.
import { decide, findReusablePass, openEpicPullRequest } from "./ci-reuse-pass.mjs";

const repo = "toddawhittaker/portikus";
const workflowPath = ".github/workflows/ci.yml";
const sha = "a".repeat(40);
const tree = "b".repeat(40);
const otherTree = "c".repeat(40);

type Run = Record<string, unknown>;
type Api = (path: string) => Promise<unknown>;

const goodRun: Run = {
	event: "pull_request",
	status: "completed",
	conclusion: "success",
	path: workflowPath,
	html_url: "https://github.com/run/7",
	repository: { full_name: repo },
	head_repository: { full_name: repo },
	pull_requests: [{ number: 12 }],
};

// The artifact list returns whatever was stored, so the script's own exact
// name check is what these tests pin, not the API's filter.
function fakeApi(artifactTree: string, run: Run, expired = false): Api {
	return async (path) => {
		if (path === `/repos/${repo}/git/commits/${sha}`) return { tree: { sha: tree } };
		if (path.startsWith(`/repos/${repo}/actions/artifacts?`)) {
			return {
				artifacts: [
					{ name: `ci-pass-${artifactTree}`, expired, workflow_run: { id: 7 } },
				],
			};
		}
		if (path === `/repos/${repo}/actions/runs/7`) return run;
		throw new Error(`unexpected ${path}`);
	};
}

const find = (api: Api) => findReusablePass({ api, repo, sha, workflowPath });

const pushEnv = {
	GITHUB_EVENT_NAME: "push",
	GITHUB_REPOSITORY: repo,
	GITHUB_SHA: sha,
	GITHUB_WORKFLOW_REF: `${repo}/${workflowPath}@refs/heads/main`,
};

describe("findReusablePass", () => {
	test("reuses a successful same-repository pull request run on the same tree", async () => {
		expect(await find(fakeApi(tree, goodRun))).toMatchObject({ tree, runId: 7 });
	});

	test("never reuses a pass recorded for another tree", async () => {
		expect(await find(fakeApi(otherTree, goodRun))).toBeNull();
	});

	test.each([
		["failed", { conclusion: "failure" }],
		["cancelled", { conclusion: "cancelled" }],
		["still running", { status: "in_progress", conclusion: null }],
		["fork", { head_repository: { full_name: "someone/portikus" } }],
		["push", { event: "push" }],
		["other workflow's", { path: ".github/workflows/other.yml" }],
	])("never reuses a %s run", async (_label, change) => {
		expect(await find(fakeApi(tree, { ...goodRun, ...change }))).toBeNull();
	});

	test("ignores an expired artifact", async () => {
		expect(await find(fakeApi(tree, goodRun, true))).toBeNull();
	});
});

describe("decide", () => {
	test("skips a push run whose tree passed, naming the tree and run", async () => {
		const result = await decide(pushEnv, fakeApi(tree, goodRun));
		expect(result.skip).toBe(true);
		expect(result.summary).toContain(tree);
		expect(result.summary).toContain("https://github.com/run/7");
	});

	test("always runs a pull request run in full", async () => {
		const result = await decide(
			{ ...pushEnv, GITHUB_EVENT_NAME: "pull_request" },
			fakeApi(tree, goodRun),
		);
		expect(result.skip).toBe(false);
	});

	test("runs everything when the API errors", async () => {
		const result = await decide(pushEnv, async () => {
			throw new Error("GitHub API 500");
		});
		expect(result).toMatchObject({ skip: false });
		expect(result.summary).toContain("500");
	});
});

describe("openEpicPullRequest", () => {
	const epicEnv = {
		...pushEnv,
		GITHUB_REF: "refs/heads/epic/76-kitestring-lab",
		GITHUB_WORKFLOW_REF: `${repo}/${workflowPath}@refs/heads/epic/76-kitestring-lab`,
	};
	const pullsPath = `/repos/${repo}/pulls?state=open&base=main&head=${encodeURIComponent("toddawhittaker:epic/76-kitestring-lab")}`;
	// No pass recorded for this tree, and the given answer for the pull request lookup.
	function epicApi(pulls: () => unknown): Api {
		return async (path) => {
			if (path === `/repos/${repo}/git/commits/${sha}`) return { tree: { sha: tree } };
			if (path.startsWith(`/repos/${repo}/actions/artifacts?`))
				return { artifacts: [] };
			if (path === pullsPath) return pulls();
			throw new Error(`unexpected ${path}`);
		};
	}

	test("skips a push to an epic branch that has an open pull request into main", async () => {
		const result = await decide(
			epicEnv,
			epicApi(() => [{ number: 2221 }]),
		);
		expect(result.skip).toBe(true);
		expect(result.summary).toContain("#2221");
	});

	test("runs a push to an epic branch with no open pull request into main", async () => {
		expect(
			await decide(
				epicEnv,
				epicApi(() => []),
			),
		).toMatchObject({ skip: false });
	});

	test("runs everything when the pull request lookup fails", async () => {
		const result = await decide(
			epicEnv,
			epicApi(() => {
				throw new Error("GitHub API 500");
			}),
		);
		expect(result).toMatchObject({ skip: false });
	});

	test("never applies to main or a task branch", async () => {
		const api = epicApi(() => [{ number: 1 }]);
		expect(
			await openEpicPullRequest({ ...epicEnv, GITHUB_REF: "refs/heads/main" }, api),
		).toBeNull();
		expect(
			await openEpicPullRequest(
				{ ...epicEnv, GITHUB_REF: "refs/heads/task/76-x" },
				api,
			),
		).toBeNull();
	});

	test("never applies to a pull request run", async () => {
		const result = await decide(
			{ ...epicEnv, GITHUB_EVENT_NAME: "pull_request" },
			epicApi(() => [{ number: 2221 }]),
		);
		expect(result.skip).toBe(false);
	});
});
