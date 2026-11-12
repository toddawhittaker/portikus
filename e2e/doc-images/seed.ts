/**
 * Demo data for `make screenshots`: invented people and a small Flask weather
 * app, written into the private run database and the fake workspace agent.
 * Nothing here is used by the browser tests.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import {
	addSession,
	createProject,
	DEX_ACCOUNT_ISSUER,
	FAKE_AGENT_TOKEN,
	query,
	seedFile,
	seedGit,
	seedListening,
	type TestProject,
	terminalIds,
	workspacePath,
	workTabs,
} from "../helpers";
import { FAKE_AGENT_URL } from "../ports";

const GIB = 1024 ** 3;
const IMAGES = join(import.meta.dirname, "../../docs/images");
const RAW = join(tmpdir(), "portikus-screenshots");
mkdirSync(RAW, { recursive: true });
// A grader's copy of each full-colour shot, before the 256-colour reduction.
const RAW_OUT = process.env.CAPTURE_RAW_OUT;
if (RAW_OUT) mkdirSync(RAW_OUT, { recursive: true });

/** Wait for fonts and animations, take the shot, and reduce it to 256 colours. */
export async function shoot(
	page: Page,
	name: string,
	options: {
		keepMouse?: boolean;
		keepToasts?: boolean;
		/** A part of the page, for a detail image. */
		clip?: { x: number; y: number; width: number; height: number };
	} = {},
): Promise<void> {
	await page.evaluate(() => document.fonts.ready);
	if (!options.keepMouse) await page.mouse.move(0, page.viewportSize()?.height ?? 0);
	await page.waitForTimeout(600);
	// A notice toast is a moment's message, not part of the screen being shown.
	const raw = join(RAW, name);
	await page.screenshot({
		path: raw,
		animations: "disabled",
		caret: "hide",
		clip: options.clip,
		style: options.keepToasts ? undefined : ".pk-toast { visibility: hidden; }",
	});
	if (RAW_OUT) copyFileSync(raw, join(RAW_OUT, name));
	execFileSync(process.env.IMAGEMAGICK ?? "convert", [
		raw,
		"-colors",
		"256",
		`PNG8:${join(IMAGES, name)}`,
	]);
}

async function post(path: string, body: unknown): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused ${path}: ${response.status}`);
}

export interface Person {
	userId: string;
	workspaceId: string;
	label: string;
}

/** A person with a workspace; signed in to `context` when one is given. */
export async function person(
	name: string,
	username: string,
	options: {
		role?: "student" | "instructor" | "administrator";
		context?: BrowserContext;
		state?: string;
	} = {},
): Promise<Person> {
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at)
		 values ($1, $2, $3, $4, $5, now() - make_interval(mins => $6)) returning id`,
		[
			DEX_ACCOUNT_ISSUER,
			`demo-${username}-${crypto.randomUUID().slice(0, 6)}`,
			`${username}@example.edu`,
			name,
			options.role ?? "student",
			// A believable last sign-in, between one hour and two days ago.
			60 + ((username.length * 397) % 2800),
		],
	);
	if (!user) throw new Error("could not create the user");
	const workspaceId = crypto.randomUUID();
	// Labels are unique, so the same person made again gets a number.
	// Labels are unique: an earlier shot's workspace gives its label up.
	const label = `ws-${username}`;
	await query(
		"update workspaces set label = 'ws-old-' || left(id::text, 8) where label = $1",
		[label],
	);
	await query(
		`insert into workspaces
		   (id, owner_user_id, label, incus_instance_name, state, desired_state,
		    agent_address, agent_token)
		 values ($1, $2, $3, $4, $5, $7, '127.0.0.1', $6)`,
		[
			workspaceId,
			user.id,
			label,
			`ws-${workspaceId.replace(/-/g, "").slice(0, 24)}`,
			options.state ?? "running",
			`${FAKE_AGENT_TOKEN}:${workspaceId}`,
			// A stopped workspace is meant to stay stopped; otherwise it reads as starting.
			options.state === "stopped" ? "stopped" : "running",
		],
	);
	// Figures a live site would show: a few GiB of a 25 GiB home, an image version.
	const spread = (username.length * 7919) % 100;
	await query("update workspaces set image_version = '2026.11.1' where id = $1", [
		workspaceId,
	]);
	await post("/__test/storage", {
		key: workspaceId,
		home: { usedBytes: Math.round((2.5 + spread / 20) * GIB), totalBytes: 25 * GIB },
		docker: { usedBytes: Math.round((0.8 + spread / 40) * GIB), totalBytes: 20 * GIB },
		recovery: {
			usedBytes: Math.round((0.2 + spread / 200) * GIB),
			totalBytes: 3 * GIB,
		},
	});
	await post("/__test/memory", {
		key: workspaceId,
		usedBytes: Math.round((0.9 + spread / 60) * GIB),
		totalBytes: 4 * GIB,
	});
	if (options.context) await addSession(options.context, user.id);
	await controllerChecked();
	return { userId: user.id, workspaceId, label };
}

const APP_PY = `"""A small weather app: today's forecast for a city."""
import os

import requests
from flask import Flask, render_template, request

app = Flask(__name__)
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"


def find_city(name):
    """Return the latitude and longitude of the first match, or None."""
    answer = requests.get(GEOCODE_URL, params={"name": name, "count": 1}, timeout=5)
    answer.raise_for_status()
    results = answer.json().get("results") or []
    if not results:
        return None
    first = results[0]
    return first["latitude"], first["longitude"]


def forecast(latitude, longitude):
    """Today's hourly temperature and chance of rain."""
    answer = requests.get(
        FORECAST_URL,
        params={
            "latitude": latitude,
            "longitude": longitude,
            "hourly": "temperature_2m,precipitation_probability",
            "forecast_days": 1,
        },
        timeout=5,
    )
    answer.raise_for_status()
    return answer.json()["hourly"]


@app.route("/")
def index():
    city = request.args.get("city", "Columbus")
    place = find_city(city)
    if place is None:
        return render_template("index.html", city=city, hours=[], missing=True)
    hourly = forecast(*place)
    hours = zip(hourly["time"], hourly["temperature_2m"], hourly["precipitation_probability"])
    return render_template("index.html", city=city, hours=list(hours), missing=False)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
`;

const README = `# Weather Now

A small Flask app that shows today's forecast for a city, using the free
[Open-Meteo](https://open-meteo.com) API.

## Run it

\`\`\`sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
flask --app app run --host 0.0.0.0
\`\`\`

Then open the **Running** tab and preview port 5000.

## Tests

\`\`\`sh
pytest
\`\`\`

## To do

- [x] Look up the city
- [x] Hourly temperature
- [ ] Show the chance of rain as a bar
- [ ] Remember the last city
`;

const TEST_PY = `from unittest.mock import patch

from app import app, find_city


def test_unknown_city_says_so():
    with patch("app.find_city", return_value=None):
        page = app.test_client().get("/?city=Nowhere")
    assert b"No city called Nowhere" in page.data


def test_find_city_reads_the_first_result():
    with patch("app.requests.get") as get:
        get.return_value.json.return_value = {
            "results": [{"latitude": 39.96, "longitude": -83.0}]
        }
        assert find_city("Columbus") == (39.96, -83.0)
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Weather Now: {{ city }}</title>
    <link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
  </head>
  <body>
    <h1>Weather in {{ city }}</h1>
    {% if missing %}
      <p>No city called {{ city }}.</p>
    {% else %}
      <table>
        {% for time, temp, rain in hours %}
          <tr><td>{{ time[11:] }}</td><td>{{ temp }} °C</td><td>{{ rain }}%</td></tr>
        {% endfor %}
      </table>
    {% endif %}
  </body>
</html>
`;

const CHECKS = {
	checks: [
		{ id: "tests", name: "Tests", command: "pytest -q" },
		{ id: "lint", name: "Lint", command: "ruff check ." },
	],
};

/** The demo project: a Flask weather app with a little Git history. */
export async function weatherProject(workspaceId: string): Promise<TestProject> {
	const project = await createProject(workspaceId, {
		name: "Weather Now",
		slug: "weather-now",
	});
	const files: Record<string, string> = {
		"app.py": APP_PY,
		"README.md": README,
		"requirements.txt": "flask==3.1.2\nrequests==2.32.5\npytest==8.4.2\n",
		"tests/test_app.py": TEST_PY,
		"templates/index.html": INDEX_HTML,
		"static/style.css":
			"body { font-family: system-ui; margin: 2rem; }\ntd { padding: 0 1rem; }\n",
		".gitignore": ".venv/\n__pycache__/\n",
		".portikus/checks.json": JSON.stringify(CHECKS, null, "\t"),
	};
	for (const [path, content] of Object.entries(files)) {
		await seedFile(workspaceId, project.slug, path, content);
	}
	await seedGit(workspaceId, project.slug, {
		status: {
			repo: true,
			branch: "main",
			detached: false,
			upstream: "origin/main",
			ahead: 1,
			behind: 0,
			conflicts: 0,
			entries: [
				{ path: "app.py", x: ".", y: "M", unmerged: false },
				{ path: "README.md", x: ".", y: "M", unmerged: false },
				{ path: "static/style.css", x: "?", y: "?", unmerged: false },
			],
			ignored: [],
			truncated: false,
		},
	});
	return project;
}

/** Two more projects, so the project list looks lived in. */
export async function otherProjects(workspaceId: string): Promise<void> {
	const portfolio = await createProject(workspaceId, { name: "Portfolio Site" });
	await seedFile(workspaceId, portfolio.slug, "index.html", "<h1>Hello</h1>\n");
	const quiz = await createProject(workspaceId, { name: "Quiz Game" });
	await seedFile(workspaceId, quiz.slug, "quiz.py", "print('Question 1')\n");
}

/** Fill a workspace's home volume, so a STORAGE_FULL error shows the full meter it names. */
export async function homeFull(workspaceId: string): Promise<void> {
	await post("/__test/storage", {
		key: workspaceId,
		home: { usedBytes: 25 * GIB, totalBytes: 25 * GIB },
		docker: { usedBytes: Math.round(1.4 * GIB), totalBytes: 20 * GIB },
		recovery: { usedBytes: Math.round(0.4 * GIB), totalBytes: 3 * GIB },
	});
}

/** The controller check the worker runs, so workspace states read as confirmed. */
export async function controllerChecked(): Promise<void> {
	await query("update settings set controller_checked_at = now() where id = 1");
}

/** Open a project and wait for its work area. */
export async function openProject(page: Page, workspaceId: string, projectId: string) {
	await controllerChecked();
	await page.goto(workspacePath(workspaceId, projectId));
	await expect(workTabs(page)).toBeVisible({ timeout: 20_000 });
}

/** Open a tab from the New tab menu; returns the new terminal id. */
export async function launch(
	page: Page,
	workspaceId: string,
	projectId: string,
	item: "terminal" | "claude" | "claude-gui" | "codex",
): Promise<string> {
	const before = await terminalIds(workspaceId, projectId);
	await page.getByTestId("launcher").click();
	await page.getByTestId(`launcher-${item}`).click();
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(before.length + 1);
	const id = (await terminalIds(workspaceId, projectId)).find(
		(one) => !before.includes(one),
	);
	if (!id) throw new Error("the new tab's terminal was not created");
	return id;
}

/** Write lines into a terminal as if a program printed them. */
export async function printTo(terminalId: string, lines: string[]): Promise<void> {
	await post(`/__test/terminals/${terminalId}/output`, { lines });
}

export interface AgentTab {
	terminalId: string;
	agent: "claude" | "codex";
	state: "working" | "needs-input" | "finished";
	since?: string;
	subagents?: {
		id: string;
		type: string;
		description: string;
		state: "working" | "finished";
	}[];
}

/** What the agents' hooks report for this workspace; each call is the whole list. */
export function setAgentTabs(workspaceId: string, terminals: AgentTab[]) {
	return post("/__test/coding-agents", { key: workspaceId, terminals });
}

/** The seven-day plan usage the agents' hooks report. */
export function setPlans(
	workspaceId: string,
	providers: { id: string; label: string; usedPercent: number; resetsAt: string }[],
) {
	return post("/__test/agent-limits", { key: workspaceId, providers });
}

export const minutesAgo = (minutes: number) =>
	new Date(Date.now() - minutes * 60_000).toISOString();
export const inHours = (hours: number) =>
	new Date(Date.now() + hours * 3_600_000).toISOString();

/** A course with an instructor and students, in the given profile. */
export async function course(
	title: string,
	instructorId: string,
	studentIds: string[],
	profile: "agentic" | "traditional" = "agentic",
): Promise<string> {
	const [row] = await query<{ id: string }>(
		`insert into lti_contexts (platform_issuer, context_id, title, platform_name, profile)
		 values ('https://lms.example.edu', $1, $2, 'Example LMS', $3) returning id`,
		[`demo-${crypto.randomUUID().slice(0, 8)}`, title, profile],
	);
	if (!row) throw new Error("could not create the course");
	await query(
		`insert into lti_memberships (context_id, user_id, role, last_launch_at)
		 values ($1, $2, 'instructor', now())`,
		[row.id, instructorId],
	);
	for (const id of studentIds) {
		await query(
			`insert into lti_memberships (context_id, user_id, role, last_launch_at)
			 values ($1, $2, 'student', now() - interval '1 day')`,
			[row.id, id],
		);
	}
	return row.id;
}

/** Flask serving the app on port 5000, as the Running and Monitor tabs see it. */
export async function flaskRunning(workspaceId: string): Promise<void> {
	const commandLine = "python3 -m flask --app app run --host 0.0.0.0";
	await seedListening(workspaceId, [
		{
			port: 5000,
			addresses: ["0.0.0.0"],
			process: { pid: 4242, command: "python3", commandLine },
		},
	]);
	await post("/__test/processes", {
		key: workspaceId,
		processes: [
			{
				pid: 4242,
				command: "python3",
				cpuPercent: 2.4,
				residentBytes: 58 * 1024 * 1024,
				startTicks: 100,
				stoppable: true,
				commandLine,
			},
			{
				pid: 4318,
				command: "pytest",
				cpuPercent: 0.3,
				residentBytes: 31 * 1024 * 1024,
				startTicks: 140,
				stoppable: true,
				commandLine: "python3 -m pytest -q --looponfail",
			},
		],
	});
}

const WEATHER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Weather Now: Columbus</title><style>
body{font-family:system-ui,sans-serif;margin:2rem 3rem;color:#1d2a35;background:#f3f7fb}
h1{font-size:1.8rem;margin:0 0 .25rem}p{color:#4b5b68;margin:0 0 1.5rem}
form{margin-bottom:1.5rem}input{font:inherit;padding:.4rem .6rem;border:1px solid #9fb3c4;border-radius:6px}
button{font:inherit;padding:.4rem .9rem;border:0;border-radius:6px;background:#2b6cb0;color:#fff}
table{border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px #0002}
th,td{padding:.5rem 1.25rem;text-align:left;border-bottom:1px solid #e3eaf0}th{background:#e8f0f8}
</style></head><body><h1>Weather in Columbus</h1><p>Today, hour by hour, from Open-Meteo.</p>
<form><input name="city" value="Columbus"> <button>Show forecast</button></form>
<table><tr><th>Time</th><th>Temperature</th><th>Chance of rain</th></tr>
<tr><td>09:00</td><td>8 °C</td><td>5%</td></tr><tr><td>12:00</td><td>13 °C</td><td>10%</td></tr>
<tr><td>15:00</td><td>15 °C</td><td>35%</td></tr><tr><td>18:00</td><td>11 °C</td><td>60%</td></tr>
<tr><td>21:00</td><td>7 °C</td><td>40%</td></tr></table></body></html>`;

/** Answer every preview-host request with the weather app's page. */
export async function servePreview(page: Page): Promise<void> {
	await page
		.context()
		.route(/\.preview\.localhost/, (route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: WEATHER_PAGE }),
		);
}

/** Give a project a saved layout before it opens. */
export async function saveLayout(projectId: string, layout: unknown): Promise<void> {
	await query("update projects set layout = $2 where id = $1", [
		projectId,
		JSON.stringify(layout),
	]);
}
