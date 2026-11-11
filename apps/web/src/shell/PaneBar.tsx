import { Icon } from "@portikus/ui";
import type { RefObject } from "react";
import { DRAWER_IDS, type DrawerName } from "./drawers.js";

/** The phone-width buttons that open the side panes as drawers (SPEC.md §8.1). */
export interface DrawerButtons {
	open: DrawerName | null;
	onOpen: (drawer: DrawerName | null) => void;
	projectsRef: RefObject<HTMLButtonElement | null>;
	filesRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The bar along the foot of a phone or narrow window: Projects and Files
 * open their drawers, Work shows the work area. Hidden by CSS where the
 * three panes sit side by side (SPEC.md §8.1).
 */
export function PaneBar({ drawers }: { drawers: DrawerButtons }) {
	const { open, onOpen } = drawers;
	return (
		<nav className="pk-panebar" aria-label="Panes" data-testid="pane-bar">
			<button
				ref={drawers.projectsRef}
				type="button"
				className="pk-panebar-item"
				data-active={open === "projects" ? "true" : undefined}
				// Named for the action: the drawer it opens is the "Projects" dialog.
				aria-label="Show projects"
				aria-haspopup="dialog"
				aria-expanded={open === "projects"}
				aria-controls={DRAWER_IDS.projects}
				onClick={() => onOpen("projects")}
			>
				<Icon name="list" size="lg" />
				<span>Projects</span>
			</button>
			<button
				type="button"
				className="pk-panebar-item"
				data-active={open === null ? "true" : undefined}
				aria-current={open === null ? "true" : undefined}
				onClick={() => onOpen(null)}
			>
				<Icon name="terminal" size="lg" />
				<span>Work</span>
			</button>
			<button
				ref={drawers.filesRef}
				type="button"
				className="pk-panebar-item"
				data-active={open === "files" ? "true" : undefined}
				aria-label="Show files"
				aria-haspopup="dialog"
				aria-expanded={open === "files"}
				aria-controls={DRAWER_IDS.files}
				onClick={() => onOpen("files")}
			>
				<Icon name="folder" size="lg" />
				<span>Files</span>
			</button>
		</nav>
	);
}
