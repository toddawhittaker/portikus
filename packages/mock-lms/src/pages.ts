import { COURSES, PEOPLE, ROLE_NAMES } from "./seed.js";
import { DEFECTS } from "./token.js";

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
label{display:block;margin-top:1rem;font-weight:600}select,button{font:inherit;margin-top:.25rem}
button{margin-top:1.5rem;padding:.5rem 1rem}iframe{width:100%;height:36rem;border:2px solid #555}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function launchPage(toolUrl: string, formToken: string): string {
	const people = PEOPLE.map(
		(p) =>
			`<option value="${p.key}">${escapeHtml(`${p.givenName} ${p.familyName} (${p.role})`)}</option>`,
	).join("");
	const courses = COURSES.map(
		(c) => `<option value="${c.key}">${escapeHtml(c.title)}</option>`,
	).join("");
	const roles = ROLE_NAMES.map((r) => `<option value="${r}">${r}</option>`).join("");
	const defects = DEFECTS.map((d) => `<option value="${d}">${d}</option>`).join("");
	return page(
		"Mock LMS",
		`<main>
<h1>Mock LMS</h1>
<p>Opens Portikus at ${escapeHtml(toolUrl)} as a seeded person. For development only.</p>
<form method="post" action="/start">
<input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
<label for="person">Person</label>
<select id="person" name="person">${people}</select>
<label for="course">Course</label>
<select id="course" name="course">${courses}</select>
<label for="role">Role</label>
<select id="role" name="role"><option value="">The person's own role</option>${roles}</select>
<label for="defect">Defect</label>
<select id="defect" name="defect"><option value="">None (a good launch)</option>${defects}</select>
<label><input type="checkbox" name="frame" value="1"> Open inside a frame</label>
<button type="submit">Launch Portikus</button>
</form>
</main>`,
	);
}

// A form that posts itself on load, with a button for when scripts are off.
export function autoPostPage(action: string, fields: Record<string, string>): string {
	const inputs = Object.entries(fields)
		.map(
			([name, value]) =>
				`<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
		)
		.join("\n");
	return page(
		"Continuing to Portikus",
		`<form id="post" method="post" action="${escapeHtml(action)}">
${inputs}
<noscript><button type="submit">Continue</button></noscript>
</form>
<script>document.getElementById("post").submit();</script>`,
	);
}

export function framePage(src: string): string {
	return page(
		"Mock LMS course frame",
		`<main>
<h1>Portikus inside a course frame</h1>
<iframe title="Portikus" src="${escapeHtml(src)}"></iframe>
<p><a href="/">Back to the launch page</a></p>
</main>`,
	);
}

export function errorPage(message: string): string {
	return page(
		"Mock LMS error",
		`<main><h1>Mock LMS refused this request</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to the launch page</a></p></main>`,
	);
}
