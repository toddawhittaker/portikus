import { Link } from "@tanstack/react-router";
import { ADMIN_HELP } from "./content/admin.js";
import { HelpDocument } from "./HelpDocument.js";
import { ADMIN_HELP_TITLE, WORKSPACE_HELP_TITLE } from "./titles.js";

/** `/admin/help`: the administrator help, shown inside the admin page under its tabs. */
export function AdminHelp({ titleId }: { titleId: string }) {
	return (
		<HelpDocument
			title={ADMIN_HELP_TITLE}
			titleId={titleId}
			parts={[ADMIN_HELP]}
			elsewhere={
				<>
					For what students and instructors see, read{" "}
					<Link className="pk-link" to="/help">
						{WORKSPACE_HELP_TITLE}
					</Link>
					.
				</>
			}
		/>
	);
}
