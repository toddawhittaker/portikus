#!/usr/bin/env node
/**
 * Decide whether a push run of CI can reuse a pull request run that already
 * passed on the exact same tree (docs/WORKFLOW.md, "CI").
 *
 *   node scripts/ci-reuse-pass.mjs
 *     Reads the GitHub Actions environment, writes `skip=true|false` to
 *     $GITHUB_OUTPUT and one line to $GITHUB_STEP_SUMMARY. Any doubt means run.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The artifact a passing pull request run uploads for its tested tree. */
const passArtifactName = (tree) => `ci-pass-${tree}`;

/**
 * Return the pull request run that passed on the tree of `sha`, or null.
 * `api(path)` returns parsed JSON for a REST path and throws on any error.
 */
export async function findReusablePass({ api, repo, sha, workflowPath }) {
	const commit = await api(`/repos/${repo}/git/commits/${sha}`);
	const tree = commit?.tree?.sha;
	if (typeof tree !== "string" || !/^[0-9a-f]{40,64}$/.test(tree)) return null;
	const name = passArtifactName(tree);
	const list = await api(
		`/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=20`,
	);
	for (const artifact of list?.artifacts ?? []) {
		if (artifact.name !== name || artifact.expired) continue;
		const runId = artifact.workflow_run?.id;
		if (!Number.isInteger(runId)) continue;
		const run = await api(`/repos/${repo}/actions/runs/${runId}`);
		// A fork's pull request runs its own edited workflow, so only runs
		// whose head is this repository can vouch for a tree.
		if (
			run?.event === "pull_request" &&
			run.status === "completed" &&
			run.conclusion === "success" &&
			run.path === workflowPath &&
			run.repository?.full_name === repo &&
			run.head_repository?.full_name === repo
		) {
			return {
				tree,
				runId,
				runUrl: run.html_url,
				pullRequests: run.pull_requests ?? [],
			};
		}
	}
	return null;
}

/** Decide for one run. Never throws: an error means run everything. */
export async function decide(env, api) {
	try {
		if (env.GITHUB_EVENT_NAME !== "push") {
			return { skip: false, summary: "Not a push run, so every job runs." };
		}
		// GITHUB_WORKFLOW_REF is "owner/repo/<path>@<ref>".
		const workflowPath = env.GITHUB_WORKFLOW_REF.split("@")[0].slice(
			env.GITHUB_REPOSITORY.length + 1,
		);
		const pass = await findReusablePass({
			api,
			repo: env.GITHUB_REPOSITORY,
			sha: env.GITHUB_SHA,
			workflowPath,
		});
		if (!pass) {
			return {
				skip: false,
				summary: "No passing pull request run for this exact tree, so every job runs.",
			};
		}
		const pr = pass.pullRequests[0]?.number;
		return {
			skip: true,
			summary: `Skipped the heavy jobs: tree ${pass.tree} already passed in pull request run ${pass.runUrl}${pr ? ` (PR #${pr})` : ""}.`,
		};
	} catch (error) {
		return {
			skip: false,
			summary: `Could not check for an earlier pass (${error.message}), so every job runs.`,
		};
	}
}

function githubApi(base, token) {
	return async (path) => {
		const response = await fetch(`${base}${path}`, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
		return response.json();
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const env = process.env;
	const { skip, summary } = await decide(
		env,
		githubApi(env.GITHUB_API_URL, env.GITHUB_TOKEN),
	);
	console.log(summary);
	if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `skip=${skip}\n`);
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
