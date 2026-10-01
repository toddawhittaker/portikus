import {
	type AdminEgressView,
	EGRESS_LIMITS,
	type EgressExplanation,
} from "@portikus/contracts";
import { shortTime, timeAgo } from "../../text.js";

/**
 * The host name inside what an administrator typed into "Test a host". A URL
 * such as https://github.com/org/repo becomes github.com; anything else is
 * passed through for explainHost to judge.
 */
export function hostFromInput(input: string): string {
	const text = input.trim();
	if (!/[/:]/.test(text)) return text;
	try {
		const url = new URL(text.includes("://") ? text : `http://${text}`);
		return url.hostname || text;
	} catch {
		return text;
	}
}

/** One plain-English sentence for a Test a host answer (SPEC.md section 20.1). */
export function verdictText(host: string, answer: EgressExplanation): string {
	switch (answer.reason) {
		case "open":
			return `Allowed. Open mode is on, so workspaces can reach ${host} and any other public site.`;
		case "preset":
			return `Allowed by the ${answer.presetLabel} preset, which lists ${answer.entry}.`;
		case "entry":
			return answer.label
				? `Allowed by your entry ${answer.entry} (${answer.label}).`
				: `Allowed by your entry ${answer.entry}.`;
		case "range":
			return answer.label
				? `Allowed by your range ${answer.range} (${answer.label}).`
				: `Allowed by your range ${answer.range}.`;
		case "denied":
			return `Blocked. ${host} is in the private range ${answer.range}, which workspaces can never reach.`;
		case "address":
			return `Not allowed. ${host} is an address. In allow-list mode an address is reached only through one of your ranges, or when it belongs to a listed name a workspace looked up.`;
		case "blocked":
			return answer.label
				? `Blocked by your list: ${answer.entry} (${answer.label}). Workspaces get "Could not resolve host" for ${host}.`
				: `Blocked by your list: ${answer.entry}. Workspaces get "Could not resolve host" for ${host}.`;
		case "not-listed":
			return `Not allowed. ${host} is not covered by a preset or your list, so workspaces get "Could not resolve host".`;
		case "invalid":
			return "That is not a host name or address. Enter a name such as github.com, or a web address.";
	}
}

/** Host names the policy lists: each enabled preset's, then the host entries, counted once. */
export function listedHostCount(view: AdminEgressView): number {
	const names = new Set<string>();
	for (const preset of view.presetCatalog) {
		if (view.presets.includes(preset.id))
			for (const host of preset.hosts) names.add(host);
	}
	for (const entry of view.entries) if (entry.kind === "host") names.add(entry.value);
	return names.size;
}

/** Reads the ports field: numbers separated by commas or spaces, or a message saying what is wrong. */
export function parsePorts(text: string): { ports: number[] } | { error: string } {
	const parts = text.split(/[\s,]+/).filter((part) => part !== "");
	if (parts.length === 0) return { error: "Enter at least one port, such as 443." };
	const ports: number[] = [];
	for (const part of parts) {
		const port = /^\d+$/.test(part) ? Number(part) : Number.NaN;
		if (!(port >= 1 && port <= 65535)) {
			return {
				error: `${part} is not a port. Ports are whole numbers from 1 to 65535.`,
			};
		}
		if (ports.includes(port)) return { error: `Port ${port} is listed twice.` };
		ports.push(port);
	}
	if (ports.length > EGRESS_LIMITS.ports) {
		return { error: `List at most ${EGRESS_LIMITS.ports} ports.` };
	}
	return { ports: ports.sort((a, b) => a - b) };
}

export type ApplyState =
	| { tone: "error"; text: string }
	| { tone: "pending"; text: string }
	| { tone: "applied"; text: string }
	| { tone: "none"; text: string };

/** "just now", "4 minutes ago", or the exact date after a day, as an audit line reads. */
function appliedAge(iso: string, now: number): string {
	if (now - Date.parse(iso) >= 86_400_000) return shortTime(iso);
	return timeAgo(iso, now).toLowerCase();
}

/** Whether the workspaces follow the saved policy yet, in one line. */
export function applyState(view: AdminEgressView, now: number): ApplyState {
	const { appliedVersion, appliedAt, error } = view.apply;
	if (error) {
		return {
			tone: "error",
			text: `The last change could not be applied: ${error.replace(/\.$/, "")}. Workspaces still follow the policy applied before it.`,
		};
	}
	if (view.version !== (appliedVersion ?? 0)) {
		return { tone: "pending", text: "Applying the latest change to every workspace…" };
	}
	if (appliedAt) {
		return {
			tone: "applied",
			text: `Applied ${appliedAge(appliedAt, now)}. Every running workspace follows this policy.`,
		};
	}
	return {
		tone: "none",
		text: "Nothing has been changed yet. Workspaces use open mode.",
	};
}

/** What a screen reader hears: the state, never the ticking age. */
export function applyAnnouncement(state: ApplyState): string {
	if (state.tone === "error") return state.text;
	if (state.tone === "pending") return "Applying the latest change to every workspace.";
	if (state.tone === "applied")
		return "Applied. Every running workspace follows this policy.";
	return "";
}
