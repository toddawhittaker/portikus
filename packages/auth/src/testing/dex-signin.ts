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
