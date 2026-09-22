/**
 * The draggable split under a list (issue #337). The handle is the same one
 * the terminal splits use. The height is kept in sessionStorage, so it lasts
 * for this browser session and not the next.
 */
import { PaneHandle } from "@portikus/ui";
import type { ReactNode } from "react";
import {
	Group,
	type LayoutStorage,
	Panel,
	useDefaultLayout,
} from "react-resizable-panels";

const sessionLayout: LayoutStorage = {
	getItem(key) {
		try {
			return sessionStorage.getItem(key);
		} catch {
			return null;
		}
	},
	setItem(key, value) {
		try {
			sessionStorage.setItem(key, value);
		} catch {
			// Private mode has no storage. The split still works for this view.
		}
	},
};

export function PaneSplit({
	storageKey,
	label,
	panel,
	children,
}: {
	storageKey: string;
	label: string;
	panel: ReactNode;
	children: ReactNode;
}) {
	const saved = useDefaultLayout({
		id: storageKey,
		storage: sessionLayout,
		// A library recompute (the pane was 0px in a test, a window resize)
		// must not overwrite the height the student dragged.
		onlySaveAfterUserInteractions: true,
	});
	return (
		<div className="pk-pane-split">
			<Group
				id={storageKey}
				orientation="vertical"
				className="pk-split"
				defaultLayout={saved.defaultLayout}
				onLayoutChanged={saved.onLayoutChanged}
			>
				<Panel
					id={`${storageKey}-list`}
					className="pk-split-panel"
					defaultSize="55%"
					minSize="20%"
				>
					{children}
				</Panel>
				<PaneHandle orientation="horizontal" label={label} />
				<Panel
					id={`${storageKey}-panel`}
					className="pk-split-panel"
					defaultSize="45%"
					minSize="15%"
				>
					{panel}
				</Panel>
			</Group>
		</div>
	);
}
