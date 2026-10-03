import { PageIntro } from "@portikus/ui";
import { type ReactNode, useId } from "react";

/**
 * Move focus to the shown tab's heading. Used when the control that had focus
 * went away, such as a link that switched tabs or a button that removed itself.
 */
export function focusAdminHeading(): void {
	document.querySelector<HTMLElement>("[data-admin-heading]")?.focus();
}

/** The frame every admin tab shares: an h2 heading row, then the tab's content (SPEC.md section 20.1). */
export function AdminSection({
	title,
	count,
	actions,
	intro,
	children,
}: {
	title: string;
	count?: ReactNode;
	actions?: ReactNode;
	/**
	 * What the tab is for, under the heading. `id` names its remembered state
	 * ("admin-users"); `helpAnchor` is the Help page section ("admin-users").
	 */
	intro?: { id: string; text: string; helpAnchor: string };
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		<section className="flex flex-col gap-4" aria-labelledby={headingId}>
			<div className="flex items-center gap-4">
				<div className="flex items-baseline gap-3">
					<h2
						className="pk-text-heading m-0"
						id={headingId}
						tabIndex={-1}
						data-admin-heading
					>
						{title}
					</h2>
					{count !== undefined ? (
						<span className="text-[13px] text-ink-muted">{count}</span>
					) : null}
				</div>
				{actions !== undefined ? (
					<div className="ml-auto flex items-center gap-2">{actions}</div>
				) : null}
			</div>
			{intro ? (
				<PageIntro
					id={intro.id}
					summary={`About ${title}`}
					helpHref={`/help#${intro.helpAnchor}`}
				>
					{intro.text}
				</PageIntro>
			) : null}
			{children}
		</section>
	);
}

/** One of a tab's h3 groups, drawn as a card, as on the Backups tab. */
export function AdminGroup({
	id,
	title,
	help,
	description,
	actions,
	children,
	testId,
}: {
	id: string;
	title: string;
	help?: ReactNode;
	/** One short line under the heading saying what the group is for. */
	description?: string;
	actions?: ReactNode;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<section
			className="pk-card @container grid gap-5 p-6"
			aria-labelledby={id}
			data-testid={testId}
		>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-2">
				<div className="grid min-w-0 flex-1 gap-1">
					<div className="flex items-center gap-1">
						<h3 className="pk-text-heading m-0" id={id} tabIndex={-1}>
							{title}
						</h3>
						{help}
					</div>
					{description ? (
						<p className="pk-muted m-0 text-[13px]">{description}</p>
					) : null}
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}

/** A titled h4 part inside an `AdminGroup`. */
export function Part({
	id,
	title,
	help,
	description,
	actions,
	children,
	testId,
}: {
	id: string;
	title: string;
	help?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<section className="grid gap-3" aria-labelledby={id} data-testid={testId}>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-2">
				<div className="grid min-w-0 flex-1 gap-1">
					<div className="flex items-center gap-1">
						<h4
							className="pk-text-compact m-0 font-semibold text-ink-muted"
							id={id}
							tabIndex={-1}
						>
							{title}
						</h4>
						{help}
					</div>
					{description ? (
						<p className="pk-muted m-0 text-[13px]">{description}</p>
					) : null}
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}
