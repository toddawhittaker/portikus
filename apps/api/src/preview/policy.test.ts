import { expect, test } from "vitest";
import { testConfig } from "../test-support.js";
import { portAllowed, previewOriginFor, requestHost } from "./policy.js";

const config = testConfig("http://127.0.0.1:3002");

test("a port inside the range and off the deny list is allowed", () => {
	expect(portAllowed(config, 5173)).toBe(true);
	expect(portAllowed(config, 1024)).toBe(true);
	expect(portAllowed(config, 65535)).toBe(true);
});

test("a port below the range, on the deny list, or the agent's own is refused", () => {
	expect(portAllowed(config, 80)).toBe(false);
	expect(portAllowed(config, 22)).toBe(false);
	expect(portAllowed(config, 5432)).toBe(false);
	// The agent port is added to the deny list whatever the variable says.
	expect(portAllowed(config, 7400)).toBe(false);
	expect(portAllowed(config, 70000)).toBe(false);
	expect(portAllowed(config, 5173.5)).toBe(false);
});

test("a narrowed range refuses ports outside it", () => {
	const narrow = testConfig("http://127.0.0.1:3002", {
		PREVIEW_PORT_MIN: 3000,
		PREVIEW_PORT_MAX: 4000,
	});
	expect(portAllowed(narrow, 2999)).toBe(false);
	expect(portAllowed(narrow, 3000)).toBe(true);
	expect(portAllowed(narrow, 4001)).toBe(false);
});

test("the host comes from X-Forwarded-Host first, with any port removed", () => {
	expect(
		requestHost({
			"x-forwarded-host": "tw7-5173.preview.localhost:8443",
			host: "someone-else.example",
		}),
	).toBe("tw7-5173.preview.localhost");
	expect(requestHost({ host: "TW7-5173.Preview.Localhost:8443" })).toBe(
		"tw7-5173.preview.localhost",
	);
	expect(requestHost({ host: "tw7-5173.preview.localhost" })).toBe(
		"tw7-5173.preview.localhost",
	);
});

test("a host that is not a plain name is refused", () => {
	expect(requestHost({})).toBeNull();
	expect(requestHost({ host: "" })).toBeNull();
	expect(requestHost({ host: ":8443" })).toBeNull();
	expect(requestHost({ host: "[::1]:8443" })).toBeNull();
	expect(requestHost({ host: "user@evil.example" })).toBeNull();
});

test("the preview origin carries the public port only when it is not 443", () => {
	expect(
		previewOriginFor(
			testConfig("http://127.0.0.1:3002", {
				PUBLIC_URL: "https://portikus.example.edu:8443",
			}),
			"tw7-5173.preview.localhost",
		),
	).toBe("https://tw7-5173.preview.localhost:8443");
	expect(
		previewOriginFor(
			testConfig("http://127.0.0.1:3002", {
				PUBLIC_URL: "https://portikus.example.edu",
			}),
			"tw7-5173.preview.localhost",
		),
	).toBe("https://tw7-5173.preview.localhost");
	expect(
		previewOriginFor(
			testConfig("http://127.0.0.1:3002", {
				PUBLIC_URL: "https://portikus.example.edu:443",
			}),
			"tw7-5173.preview.localhost",
		),
	).toBe("https://tw7-5173.preview.localhost");
});
