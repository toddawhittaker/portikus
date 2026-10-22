import { Button } from "@portikus/ui";
import type { ReactNode } from "react";
import { errorText } from "../../api/request.js";
import { Notice } from "../Notice.js";
import type { SettingsSection } from "./sections.js";

/**
 * One section of the Settings tab: a card with its heading, which the
 * section index links to, and one line on what it is for. The card is a
 * container, so its rows lay out by the card's width, not the window's.
 */
export function SectionCard({
	section,
	description,
	children,
}: {
	section: SettingsSection;
	description: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			className="pk-card @container/card grid grid-cols-[minmax(0,1fr)] gap-5 p-6 @max-[30rem]/settings:p-4"
			aria-labelledby={section.id}
			data-testid={section.id}
		>
			<div className="grid gap-1">
				<h3 className="pk-text-heading m-0" id={section.id} tabIndex={-1}>
					{section.title}
				</h3>
				<p className="pk-muted m-0 max-w-[72ch] text-[13px]">{description}</p>
			</div>
			{children}
		</section>
	);
}

/** A titled part inside a section, such as one group of the resource guard. */
export function SectionGroup({
	id,
	title,
	description,
	children,
}: {
	id: string;
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="grid min-w-0 gap-3" aria-labelledby={id}>
			<div className="grid gap-1">
				<h4 className="pk-text-compact m-0 font-semibold text-ink" id={id}>
					{title}
				</h4>
				{description ? (
					<p className="pk-muted m-0 max-w-[72ch] text-[13px]">{description}</p>
				) : null}
			</div>
			{children}
		</section>
	);
}

/**
 * The settings could not be read. Nothing changed on the server, so the
 * notice says so and offers to read them again.
 */
export function LoadFailed({
	error,
	onRetry,
	retrying,
	announce,
}: {
	error: unknown;
	onRetry: () => void;
	retrying: boolean;
	/** Only one section announces a failure the others share. */
	announce: boolean;
}) {
	return (
		<div className="grid justify-items-start gap-3">
			<div role={announce ? "alert" : undefined} className="w-full">
				<Notice tone="error">
					These settings could not be loaded.{" "}
					{errorText(error, "The server did not answer.")} Nothing has been changed.
				</Notice>
			</div>
			<Button onClick={onRetry} loading={retrying}>
				Load again
			</Button>
		</div>
	);
}
