// The show-or-hide button in Dex's password field (ADR 0023, "Pages";
// SPEC.md section 25.8). web.yml loads this file at the end of
// password.html. Without it the field is an ordinary password field.
(() => {
	const input = document.getElementById("password");
	if (!input) return;

	const EYE =
		'<svg class="theme-password-eye" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
		'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
	const EYE_OFF =
		'<svg class="theme-password-eye-off" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
		'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>';

	const wrap = document.createElement("span");
	wrap.className = "theme-password";
	input.parentNode.insertBefore(wrap, input);
	wrap.appendChild(input);

	const button = document.createElement("button");
	button.type = "button";
	button.className = "theme-password-toggle";
	button.innerHTML = EYE + EYE_OFF;
	wrap.appendChild(button);

	// The open eye offers to show the password; the crossed-out eye, to hide it.
	function show(visible) {
		input.type = visible ? "text" : "password";
		button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
		button.querySelector(".theme-password-eye").style.display = visible ? "none" : "";
		button.querySelector(".theme-password-eye-off").style.display = visible
			? ""
			: "none";
	}
	show(false);

	// A tap or click leaves the focus and the cursor in the field.
	button.addEventListener("mousedown", (event) => {
		event.preventDefault();
	});
	button.addEventListener("click", () => {
		const start = input.selectionStart;
		const end = input.selectionEnd;
		show(input.type === "password");
		if (document.activeElement === input) input.setSelectionRange(start, end);
	});

	// Hidden again on every load, including a return through the back button,
	// and before the form is sent, so the browser saves it as a password.
	window.addEventListener("pageshow", () => {
		show(false);
	});
	if (input.form) {
		input.form.addEventListener("submit", () => {
			show(false);
		});
	}
})();
