import { IconButton } from "@portikus/ui";
import { displayName } from "../files/paths.js";
import type { ComposerAttachment } from "./composerAttachments.js";

/** The files waiting to go with the next message, each removable. */
export function ComposerChips({
	items,
	saving,
	onRemove,
}: {
	items: ComposerAttachment[];
	saving: number;
	onRemove: (key: string) => void;
}) {
	if (items.length === 0 && saving === 0) return null;
	return (
		<ul className="pk-composer-chips" aria-label="Attachments">
			{items.map((item) => (
				<li key={item.key} className="pk-composer-chip" data-testid="composer-chip">
					{item.previewUrl ? (
						<img className="pk-composer-thumb" src={item.previewUrl} alt="" />
					) : null}
					<span className="pk-composer-chip-name" title={item.path}>
						{displayName(item.name)}
					</span>
					<IconButton
						icon="x"
						size="sm"
						label={`Remove ${displayName(item.name)}`}
						onClick={() => onRemove(item.key)}
					/>
				</li>
			))}
			{saving > 0 ? (
				<li className="pk-composer-chip pk-chat-muted" data-testid="composer-saving">
					Saving {saving === 1 ? "1 file" : `${saving} files`}…
				</li>
			) : null}
		</ul>
	);
}
