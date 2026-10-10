import { AdminGroup } from "../AdminSection.js";

/** The single sign-on provider: view, trial, test and keep (ADR 0059). */
export function SsoGroup() {
	return (
		<AdminGroup id="admin-signin-sso" title="Single sign-on" testId="admin-signin-sso">
			{null}
		</AdminGroup>
	);
}
