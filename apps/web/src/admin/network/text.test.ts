import { type AdminEgressView, explainHost } from "@portikus/contracts";
import { expect, test } from "vitest";
import { egressView } from "./testView.js";
import {
	ago,
	applyAnnouncement,
	applyState,
	hostFromInput,
	joinPorts,
	listedHostCount,
	parsePorts,
	verdictText,
} from "./text.js";

test("a URL is reduced to its host name; anything else passes through", () => {
	expect(hostFromInput("https://github.com/org/repo")).toBe("github.com");
	expect(hostFromInput(" pypi.org/simple ")).toBe("pypi.org");
	expect(hostFromInput("api.example.edu:8443")).toBe("api.example.edu");
	expect(hostFromInput("github.com")).toBe("github.com");
	expect(hostFromInput("*.bad")).toBe("*.bad");
	expect(hostFromInput("http://[")).toBe("http://[");
});

test("every explanation reads as one plain sentence", () => {
	const view = egressView();
	const say = (input: string, policy = view) =>
		verdictText(input, explainHost(policy, input));
	expect(say("api.github.com")).toBe(
		"Allowed by the GitHub preset, which lists github.com.",
	);
	expect(say("x.api.example.edu")).toBe(
		"Allowed by your entry api.example.edu (Course API).",
	);
	expect(say("203.0.113.9")).toBe("Allowed by your range 203.0.113.0/24.");
	expect(say("10.1.2.3")).toContain("private range 10.0.0.0/8");
	expect(say("198.51.100.1")).toContain("is an address");
	expect(say("example.org")).toContain('"Could not resolve host"');
	expect(say("not a host")).toContain("not a host name");
	expect(say("example.org", egressView({ mode: "open" }))).toContain("Open mode is on");
	const labelled = egressView({
		entries: [
			{ ...view.entries[1], label: "Lab" } as AdminEgressView["entries"][number],
		],
	});
	expect(say("203.0.113.9", labelled)).toBe(
		"Allowed by your range 203.0.113.0/24 (Lab).",
	);
	const unlabelled = egressView({
		entries: [{ ...view.entries[0], label: "" } as AdminEgressView["entries"][number]],
	});
	expect(say("api.example.edu", unlabelled)).toBe(
		"Allowed by your entry api.example.edu.",
	);
});

test("listed hosts count each enabled preset's hosts and the host entries once", () => {
	expect(listedHostCount(egressView())).toBe(4);
	expect(
		listedHostCount(
			egressView({
				presets: [],
				entries: [
					{
						...egressView().entries[0],
						value: "github.com",
					} as AdminEgressView["entries"][number],
				],
			}),
		),
	).toBe(1);
});

test("ports join as a sentence", () => {
	expect(joinPorts([443])).toBe("443");
	expect(joinPorts([22, 80, 443])).toBe("22, 80 and 443");
});

test("the ports field says what is wrong", () => {
	expect(parsePorts("443, 22 80")).toEqual({ ports: [22, 80, 443] });
	expect(parsePorts(" ")).toEqual({ error: "Enter at least one port, such as 443." });
	expect(parsePorts("80, http")).toEqual({
		error: "http is not a port. Ports are whole numbers from 1 to 65535.",
	});
	expect(parsePorts("0")).toHaveProperty("error");
	expect(parsePorts("70000")).toHaveProperty("error");
	expect(parsePorts("80,80")).toEqual({ error: "Port 80 is listed twice." });
	const many = Array.from({ length: 21 }, (_, i) => i + 1).join(",");
	expect(parsePorts(many)).toEqual({ error: "List at most 20 ports." });
});

test("ages read as words, then as a date", () => {
	const now = Date.parse("2026-09-27T12:00:00.000Z");
	expect(ago("2026-09-27T11:59:30.000Z", now)).toBe("just now");
	expect(ago("2026-09-27T11:59:00.000Z", now)).toBe("1 minute ago");
	expect(ago("2026-09-27T11:30:00.000Z", now)).toBe("30 minutes ago");
	expect(ago("2026-09-27T11:00:00.000Z", now)).toBe("1 hour ago");
	expect(ago("2026-09-27T09:00:00.000Z", now)).toBe("3 hours ago");
	expect(ago("2026-09-20T09:00:00.000Z", now)).toMatch(/Sep/);
});

test("the apply status names an error, a pending change, the last apply, or nothing yet", () => {
	const now = Date.parse("2026-09-27T10:00:10.000Z");
	expect(applyState(egressView(), now)).toEqual({
		tone: "applied",
		text: "Applied just now. Every running workspace follows this policy.",
	});
	expect(applyState(egressView({ version: 4 }), now).tone).toBe("pending");
	expect(
		applyState(
			egressView({
				apply: { appliedVersion: 2, appliedAt: null, error: "nft refused the table." },
			}),
			now,
		),
	).toEqual({
		tone: "error",
		text: "The last change could not be applied: nft refused the table. Workspaces still follow the policy applied before it.",
	});
	expect(
		applyState(
			egressView({
				version: 0,
				apply: { appliedVersion: null, appliedAt: null, error: null },
			}),
			now,
		).tone,
	).toBe("none");
});

test("the announcement names the state and never the age", () => {
	const applied = applyState(egressView(), Date.parse("2026-09-27T12:00:00.000Z"));
	expect(applyAnnouncement(applied)).toBe(
		"Applied. Every running workspace follows this policy.",
	);
	expect(applyAnnouncement({ tone: "pending", text: "x" })).toBe(
		"Applying the latest change to every workspace.",
	);
	expect(applyAnnouncement({ tone: "error", text: "Failed." })).toBe("Failed.");
	expect(applyAnnouncement({ tone: "none", text: "x" })).toBe("");
});
