import { useEffect } from "react";

/**
 * Names the browser tab after the page, "<name>, Portikus" (issue #374,
 * WCAG 2.4.2). An empty name leaves plain "Portikus", as does leaving the page.
 */
export function usePageTitle(name: string) {
	useEffect(() => {
		document.title = name ? `${name}, Portikus` : "Portikus";
		return () => {
			document.title = "Portikus";
		};
	}, [name]);
}
