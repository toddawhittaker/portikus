import { expect, test } from "vitest";
import { lineSummary, requestSummary } from "./summary.js";

test("a successful read names what was loaded, without its parameters", () => {
	expect(requestSummary("GET", "/admin/logs", 200)).toBe("Loaded admin logs");
	expect(requestSummary("GET", "/admin/root-shell", 200)).toBe(
		"Loaded admin root shell",
	);
	expect(requestSummary("GET", "/me/profile", 200)).toBe("Loaded own profile");
	expect(requestSummary("POST", "/workspaces/:id/terminals", 201)).toBe(
		"Sent to workspaces terminals",
	);
	expect(requestSummary("PATCH", "/admin/settings", 200)).toBe(
		"Updated admin settings",
	);
	expect(requestSummary("DELETE", "/admin/users/:id", 204)).toBe("Deleted admin users");
	expect(requestSummary("OPTIONS", "/", 204)).toBe("Answered the home page");
	expect(requestSummary("GET", "/auth/me", 200)).toBe("Session checked");
});

test("redirects and refusals say what happened, by status", () => {
	expect(requestSummary("GET", "/auth/login", 302)).toBe(
		"Sent to the sign-in provider",
	);
	expect(requestSummary("GET", "/auth/callback", 302)).toBe(
		"Back from the sign-in provider",
	);
	expect(requestSummary("GET", "/old", 301)).toBe("Redirected from old");
	expect(requestSummary("GET", "/auth/me", 401)).toBe("Signed-out request refused");
	expect(requestSummary("GET", "/admin/users", 403)).toBe(
		"Refused, no permission for admin users",
	);
	expect(requestSummary("GET", "", 404)).toBe("No such address");
	expect(requestSummary("GET", "/projects/:id", 404)).toBe("Not found in projects");
	expect(requestSummary("POST", "/a", 429)).toBe("Too many requests, slowed down");
	expect(requestSummary("POST", "/workspaces/:id/start", 409)).toBe(
		"Refused: workspaces start",
	);
	expect(requestSummary("GET", "/admin/health", 503)).toBe(
		"Server error on admin health",
	);
});

test("only the bare request line is summarised; an error or another message stays as written", () => {
	expect(
		lineSummary({ msg: "request", method: "GET", route: "/courses", status: 200 }),
	).toBe("Loaded courses");
	expect(
		lineSummary({ msg: "request", error: "Sign in to continue", status: 401 }),
	).toBe("Sign in to continue");
	expect(lineSummary({ msg: "workspace started" })).toBe("workspace started");
	expect(lineSummary({ msg: "request" })).toBe("Request answered");
});
