import { field, messageOf } from "./line.js";

/** Route words that read better in plain English. */
const WORD: Record<string, string> = { me: "own", auth: "sign-in" };

/** The route's fixed parts as words: "/admin/root-shell" is "admin root shell"; parameters are left out. */
function routeWords(route: string): string {
	const words = route
		.split("/")
		.filter((part) => part !== "" && !part.startsWith(":") && part !== "*")
		.map((part) => WORD[part] ?? part.replaceAll("-", " "));
	return words.length > 0 ? words.join(" ") : "the home page";
}

function sentence(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

const VERB: Record<string, string> = {
	GET: "loaded",
	HEAD: "checked",
	POST: "sent to",
	PUT: "updated",
	PATCH: "updated",
	DELETE: "deleted",
};

/**
 * What one answered request did, in plain words, from the method, route and
 * status the API logged with it (SPEC.md section 24.11). Only those fields
 * are read, so the summary never claims more than the line holds.
 */
export function requestSummary(method: string, route: string, status: number): string {
	const words = routeWords(route);
	if (status >= 500) return `Server error on ${words}`;
	if (status === 401) return "Signed-out request refused";
	if (status === 403) return `Refused, no permission for ${words}`;
	if (status === 404) return route ? `Not found in ${words}` : "No such address";
	if (status === 429) return "Too many requests, slowed down";
	if (status >= 400) return `Refused: ${words}`;
	if (status >= 300) {
		if (route.startsWith("/auth/login")) return "Sent to the sign-in provider";
		if (route.startsWith("/auth/callback")) return "Back from the sign-in provider";
		return `Redirected from ${words}`;
	}
	if (route === "") return "Request answered";
	if (route === "/auth/me") return "Session checked";
	return sentence(`${VERB[method.toUpperCase()] ?? "answered"} ${words}`);
}

/** The row's message: the API's bare "request" line becomes a summary; any other line keeps its own words. */
export function lineSummary(body: Record<string, unknown>): string {
	const message = messageOf(body);
	if (message !== "request") return message;
	const status = Number.parseInt(field(body, "status"), 10);
	return requestSummary(
		field(body, "method"),
		field(body, "route"),
		Number.isNaN(status) ? 0 : status,
	);
}
