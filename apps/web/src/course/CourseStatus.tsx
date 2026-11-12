import type { ReactNode } from "react";

/**
 * One live region that stays mounted under the heading, so a screen reader
 * hears the loading text change to the error or empty text.
 */
export function CourseStatus({ children }: { children: ReactNode }) {
	return (
		<p className="pk-text-body pk-muted mt-4" role="status">
			{children}
		</p>
	);
}
