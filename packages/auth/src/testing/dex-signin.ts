/**
 * What a browser does between Portikus's redirect and the callback: follow
 * Dex to its password form, post it, and follow on. Returns the callback URL
 * when Dex sends the browser back, or null with the last page otherwise.
 * Used by the tests that sign in through a real Dex.
 */
export async function submitDexPasswordForm(
	loginUrl: string,
	callbackUrl: string,
	login: string,
	password: string,
): Promise<{ callback: URL | null; page: string }> {
	let url = loginUrl;
	let init: RequestInit = {};
	let posted = false;
	for (let hop = 0; hop < 10; hop++) {
		const res = await fetch(url, { ...init, redirect: "manual" });
		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			const next = new URL(location, url);
			if (next.href.startsWith(callbackUrl)) return { callback: next, page: "" };
			url = next.href;
			init = {};
			continue;
		}
		const page = await res.text();
		if (posted) return { callback: null, page };
		const action = /<form method="post" action="([^"]*)"/.exec(page)?.[1];
		if (!action) throw new Error(`no password form at ${url} (status ${res.status})`);
		url = new URL(action.replaceAll("&amp;", "&"), url).href;
		init = {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ login, password }).toString(),
		};
		posted = true;
	}
	throw new Error("too many redirects");
}

/**
 * What a browser does when a person picks an upstream connector on Dex's
 * sign-in page and signs in at the mock provider as mockUser: follow Dex to
 * the connector, pick the user on the mock's page, and follow on. Returns the
 * callback URL when Dex sends the browser back, or null with the last page.
 */
export async function signInThroughDexUpstream(
	loginUrl: string,
	callbackUrl: string,
	connectorId: string,
	mockUser: string,
): Promise<{ callback: URL | null; page: string }> {
	let url = loginUrl;
	for (let hop = 0; hop < 15; hop++) {
		const res = await fetch(url, { redirect: "manual" });
		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			const next = new URL(location, url);
			if (next.href.startsWith(callbackUrl)) return { callback: next, page: "" };
			// The mock's authorize endpoint lists its users; choose one.
			if (next.pathname.endsWith("/authorize") && !next.searchParams.has("user")) {
				next.searchParams.set("user", mockUser);
			}
			url = next.href;
			continue;
		}
		const page = await res.text();
		// Dex's chooser, shown because local passwords sit beside the connector.
		const link = new RegExp(`href="([^"]*/auth/${connectorId}\\?[^"]*)"`).exec(
			page,
		)?.[1];
		if (res.status !== 200 || !link) return { callback: null, page };
		// Go's templates escape "+" in the scope as &#43;.
		const decoded = link
			.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
			.replaceAll("&amp;", "&");
		url = new URL(decoded, url).href;
	}
	throw new Error("too many redirects");
}
