import { Button } from "@portikus/ui";
import type { ReactNode } from "react";
import { errorText } from "../../api/request.js";
import { Notice } from "../Notice.js";
import { MoreAbout } from "./SettingRow.js";
import type { SettingsSection } from "./sections.js";

/**
 * One section of the Settings tab: a card with its heading, which the
 * section index links to, and one line on what it is for. The card is a
 * container, so its rows lay out by the card's width, not the window's.
 */
export function SectionCard({
	section,
	description,
	more,
	children,
}: {
	section: SettingsSection;
	description: ReactNode;
	/** The rest of the explanation, folded so the one line stays the first thing read. */
	more?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			className="pk-card @container/card grid grid-cols-[minmax(0,1fr)] gap-5 p-6 @max-[30rem]/settings:p-4"
			aria-labelledby={section.id}
			data-testid={section.id}
		>
			<div className="grid gap-1">
				<h3
					className="pk-text-heading m-0 scroll-mt-20 @min-[62rem]/settings:scroll-mt-4"
					id={section.id}
					tabIndex={-1}
				>
					{section.title}
				</h3>
				<p className="pk-muted m-0 max-w-[60ch] text-[13px] leading-[18px]">
					{description}
				</p>
				{more ? <MoreAbout label={section.title}>{more}</MoreAbout> : null}
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
	more,
	children,
}: {
	id: string;
	title: string;
	description?: ReactNode;
	more?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="grid min-w-0 gap-3" aria-labelledby={id}>
			<div className="grid gap-1">
				<h4 className="pk-text-compact m-0 font-semibold text-ink" id={id}>
					{title}
				</h4>
				{description ? (
					<p className="pk-muted m-0 max-w-[60ch] text-[13px] leading-[18px]">
						{description}
					</p>
				) : null}
				{more ? <MoreAbout label={title}>{more}</MoreAbout> : null}
			</div>
			{children}
		</section>
	);
}

/**
 * A section whose settings have not arrived: the shape of its rows while
 * they load, or what went wrong if the read failed.
 */
export function SectionNotLoaded({
	section,
	description,
	read,
	announce,
	skeleton,
}: {
	section: SettingsSection;
	description: ReactNode;
	read: {
		isError: boolean;
		error: unknown;
		isFetching: boolean;
		refetch: () => unknown;
	};
	announce: boolean;
	skeleton: ReactNode;
}) {
	return (
		<SectionCard section={section} description={description}>
			{read.isError ? (
				<LoadFailed
					error={read.error}
					retrying={read.isFetching}
					announce={announce}
					onRetry={() => void read.refetch()}
				/>
			) : (
				<div aria-busy="true" className="grid gap-5">
					{skeleton}
				</div>
			)}
		</SectionCard>
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
