/** The stubbed API the Settings dialog tests share (SPEC.md section 13.5). */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { expect } from "vitest";
import { json, stubFetch, USER } from "../test-utils.js";

export interface Sent {
	body: unknown;
}

/**
 * The zone names the server says it accepts. The dialog offers these and
 * nothing else, so the browser's own zone list never comes into it.
 */
export const SERVER_ZONES = [
	"UTC",
	"America/New_York",
	"Europe/Berlin",
	"Europe/Madrid",
	"Asia/Tokyo",
];

/** Answers GET /me/settings with `stored` and records what is written. */
export function stubSettings(
	stored = EDITOR_SETTINGS_DEFAULTS,
	user: Record<string, unknown> | null = null,
) {
	const writes: Sent[] = [];
	let current = { ...stored, timezones: SERVER_ZONES };
	let profile = { ...PROFILE };
	stub.profileWrites = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") {
			if (!user) throw new Error("unexpected request to /auth/me");
			return json(200, user);
		}
		if (url === "/me/profile") {
			if ((init?.method ?? "GET") !== "GET") {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				stub.profileWrites.push({ body });
				profile = { ...profile, ...body };
			}
			return json(200, profile);
		}
		if (url === "/me/links") return json(200, stub.myLinks);
		if (url === "/me/links/start") {
			stub.linkWrites.push(url);
			return stub.startAnswer;
		}
		if (url.startsWith("/me/links/") && url.endsWith("/unlink")) {
			stub.linkWrites.push(url);
			stub.myLinks = {
				...stub.myLinks,
				links: stub.myLinks.links.filter((link) => !url.includes(link.courseUserId)),
			};
			return json(200, { signedOut: stub.unlinkSignsOut });
		}
		if (url === "/me/password") return new Response(null, { status: 204 });
		if (url === "/me/picture") {
			return json(413, { code: "FILE_TOO_LARGE", message: "The picture is too big" });
		}
		if (url !== "/me/settings") throw new Error(`unexpected request to ${url}`);
		if ((init?.method ?? "GET") !== "GET") {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			writes.push({ body });
			current = { ...current, ...body } as typeof current;
		}
		return json(200, current);
	});
	return writes;
}

/** What GET /me/profile answers with before anything is changed. */
export const PROFILE = {
	displayName: "Alice Example",
	email: "alice@example.edu",
	workspaceLabel: "alice",
	github: null,
	website: null,
	picture: null,
};

const NO_LINKS: LinksAnswer = {
	source: "sso",
	linkUntil: null,
	links: [],
	launch: null,
};

/** What the stubbed API holds and has been sent; each test starts from resetStubs(). */
export const stub = {
	/** Profile writes seen by the last stubSettings. */
	profileWrites: [] as Sent[],
	/** What GET /me/links answers; an SSO account with no links unless a test says otherwise. */
	myLinks: NO_LINKS,
	startAnswer: json(200, { redirectUrl: "https://sso.example.edu/authorize?x=1" }),
	linkWrites: [] as string[],
	unlinkSignsOut: false,
};

interface LinksAnswer {
	source: string;
	linkUntil: string | null;
	links: { courseUserId: string; [key: string]: unknown }[];
	launch: null;
}

export function resetStubs() {
	stub.profileWrites = [];
	stub.myLinks = NO_LINKS;
	stub.startAnswer = json(200, {
		redirectUrl: "https://sso.example.edu/authorize?x=1",
	});
	stub.linkWrites = [];
	stub.unlinkSignsOut = false;
}

export function checkbox(name: RegExp) {
	return screen.getByRole("checkbox", { name });
}

/** The accessible name is the whole string, not a substring of a longer one. */
export function buttonNamed(label: string): HTMLElement {
	const found = screen
		.getAllByRole("button")
		.filter((button) => button.textContent === label);
	expect(found).toHaveLength(1);
	const button = found[0];
	if (!button) throw new Error(`missing button ${label}`);
	return button;
}

export const ACCOUNT_USER = { ...USER, signInName: "university-alice" };

export async function openProfile() {
	fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
	await screen.findByLabelText("GitHub");
}
