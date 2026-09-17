import { Link } from "@tanstack/react-router";

/** Where terminal links land until the file and preview epics arrive. */
export function ComingLater({
	title,
	workspaceId,
	detail,
}: {
	title: string;
	workspaceId: string;
	detail: string;
}) {
	return (
		<main>
			<h1>{title}</h1>
			<p>{detail}</p>
			<p>Coming in a later epic.</p>
			<p>
				<Link to="/workspaces/$id" params={{ id: workspaceId }}>
					Back to the workspace
				</Link>
			</p>
		</main>
	);
}
