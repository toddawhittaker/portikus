import { Icon, IconButton } from "@portikus/ui";
import { useLayoutEffect, useRef, useState } from "react";
import { displayName } from "../files/paths.js";
import { type ComposerAttachment, lineText } from "./composerAttachments.js";

const SIZE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** "340 KB" or "1.2 MB": enough to see a picture was made smaller. */
function fileSize(bytes: number): string {
	if (bytes < 1024 * 1024)
		return `${SIZE.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
	return `${SIZE.format(bytes / (1024 * 1024))} MB`;
}

/**
 * The files waiting to go with the next message, each removable. A picture
 * shows a thumbnail large enough to check it is the right one. After a
 * removal the keyboard moves to the next file's Remove button, else the one
 * before, else the message box (SPEC.md §25.8). A long paste can also be
 * put in the message box as text, which needs no timing (SPEC.md §25.8).
 */
export function ComposerChips({
	items,
	saving,
	onRemove,
	onInsert,
	onEmptied,
}: {
	items: ComposerAttachment[];
	saving: number;
	onRemove: (key: string) => void;
	/** Put a long paste's text in the box. Absent while a message that names the file is on its way. */
	onInsert?: ((key: string) => void) | undefined;
	/** The last file was removed from the keyboard; put it somewhere useful. */
	onEmptied: () => void;
}) {
	const list = useRef<HTMLUListElement | null>(null);
	const [focusNext, setFocusNext] = useState<string | null>(null);

	useLayoutEffect(() => {
		if (focusNext === null) return;
		setFocusNext(null);
		const button = list.current?.querySelector<HTMLElement>(
			`[data-chip="${focusNext}"] [data-chip-remove]`,
		);
		if (button) button.focus();
		else onEmptied();
	}, [focusNext, onEmptied]);

	if (items.length === 0 && saving === 0) return null;

	function remove(at: number) {
		const item = items[at];
		if (!item) return;
		const neighbour = items[at + 1] ?? items[at - 1];
		setFocusNext(neighbour?.key ?? "");
		onRemove(item.key);
	}

	return (
		<ul ref={list} className="pk-composer-chips" aria-label="Attachments">
			{items.map((item, at) => (
				<li
					key={item.key}
					className="pk-composer-chip"
					data-chip={item.key}
					data-testid="composer-chip"
				>
					{item.previewUrl ? (
						<img
							className="pk-composer-thumb"
							src={item.previewUrl}
							alt=""
							width={56}
							height={56}
						/>
					) : (
						<span
							className="pk-composer-thumb pk-composer-thumb--file"
							aria-hidden={true}
						>
							<Icon name="file" size="lg" />
						</span>
					)}
					<span className="pk-composer-chip-copy">
						<span className="pk-composer-chip-name" title={item.path}>
							{displayName(item.name)}
						</span>
						<span className="pk-composer-chip-size" data-testid="composer-chip-size">
							{item.lines === null ? fileSize(item.size) : lineText(item.lines)}
						</span>
					</span>
					{item.text !== null && onInsert ? (
						<IconButton
							icon="list"
							size="sm"
							label={`Insert pasted text inline (${displayName(item.name)})`}
							data-testid="composer-chip-insert"
							onClick={() => onInsert(item.key)}
						/>
					) : null}
					<IconButton
						icon="x"
						size="sm"
						label={`Remove ${displayName(item.name)}`}
						data-chip-remove={true}
						onClick={() => remove(at)}
					/>
				</li>
			))}
			{saving > 0 ? (
				<li
					className="pk-composer-chip pk-composer-chip--saving"
					data-testid="composer-saving"
				>
					<span
						className="pk-composer-thumb pk-composer-thumb--file"
						aria-hidden={true}
					>
						<span className="pk-spin" />
					</span>
					<span className="pk-chat-muted">
						Saving {saving === 1 ? "1 file" : `${saving} files`}…
					</span>
				</li>
			) : null}
		</ul>
	);
}
