import type * as React from "react";
import { Icon, type IconName } from "./Icon.js";

export interface StateArtProps {
	/** The glyph in the corner badge, which says what kind of state this is. */
	icon?: IconName;
	/** Error tints the backdrop and badge; everything else is the accent. */
	tone?: "accent" | "error";
	/** The cursor in the doorway blinks while something is under way. */
	busy?: boolean;
}

/**
 * The small picture above an empty, starting or error message: the portico of
 * the Portikus mark with a prompt in its doorway, so every such state shares
 * one look. Decorative; the heading beside it says what it means.
 */
export function StateArt({
	icon,
	tone = "accent",
	busy = false,
}: StateArtProps): React.ReactElement {
	return (
		<span
			className={`pk-art pk-art--${tone}${busy ? " pk-art--busy" : ""}`}
			aria-hidden={true}
			data-testid="state-art"
		>
			<svg viewBox="0 0 96 72" className="pk-art-scene" aria-hidden={true}>
				<circle className="pk-art-backdrop" cx="48" cy="38" r="32" />
				<path className="pk-art-stone" d="M48 10 72 23H24z M26 25h44v3H26z" />
				<path className="pk-art-stone" d="M30 30h7v22h-7z M59 30h7v22h-7z" />
				<rect className="pk-art-step" x="22" y="54" width="52" height="5" rx="1.5" />
				<rect className="pk-art-door" x="39.5" y="31" width="17" height="21" rx="2" />
				<path className="pk-art-prompt" d="m42 37 5 3.5-5 3.5v-2.3l2-1.2-2-1.2z" />
				<rect className="pk-art-cursor" x="48" y="42.5" width="5" height="2" rx="0.5" />
			</svg>
			{icon ? (
				<span className="pk-art-badge">
					<Icon name={icon} size="sm" />
				</span>
			) : null}
		</span>
	);
}
