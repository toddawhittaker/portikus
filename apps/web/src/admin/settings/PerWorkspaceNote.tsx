import { Link } from "@tanstack/react-router";

/** Said once per section instead of under every box: where one workspace's own value is set. */
export function PerWorkspaceNote() {
	return (
		<>
			Rules marked “Per workspace too” can be changed for one workspace from its panel
			on the{" "}
			<Link
				to="/admin/$tab"
				params={{ tab: "users" }}
				className="font-medium text-accent-text underline-offset-[3px] hover:underline"
			>
				Users tab
			</Link>
			.
		</>
	);
}
