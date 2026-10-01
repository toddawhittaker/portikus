import { GithubLink, githubHref, WebsiteLink } from "@portikus/contracts";
import { Button, LABEL_CLASS, TextField, Toggletip } from "@portikus/ui";
import { useRef } from "react";
import { useMe } from "../useMe.js";
import { ControlFrame, useShowSetting } from "./controls.js";
import { LinkedAccounts } from "./LinkedAccounts.js";
import { useProfile, useRemovePicture, useUploadPicture } from "./profileQueries.js";
import { SETTINGS_SECTIONS } from "./sections.js";

const PROFILE = SETTINGS_SECTIONS.find((section) => section.id === "profile");

/** The profile links the student has typed but not saved yet. */
export interface LinkDraft {
	github?: string;
	website?: string;
}

/** A blank link clears it; anything else must pass the same check the API makes. */
export function checkLink(
	schema: typeof GithubLink | typeof WebsiteLink,
	text: string | undefined,
): { value: string | null | undefined; error: string | null } {
	if (text === undefined) return { value: undefined, error: null };
	if (text.trim() === "") return { value: null, error: null };
	const parsed = schema.safeParse(text);
	return parsed.success
		? { value: parsed.data, error: null }
		: {
				value: undefined,
				error: parsed.error.issues[0]?.message ?? "Not a valid link",
			};
}

/** Up to two initials for the avatar placeholder. */
export function initials(displayName: string): string {
	const parts = displayName.trim().split(/\s+/).slice(0, 2);
	const letters = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
	return letters || "?";
}

/** A saved link, shown only as a plain anchor (issue #300). */
function SavedLink({ href, testId }: { href: string; testId: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener"
			data-testid={testId}
			className="pk-text-compact break-all text-[var(--accent-text)] underline"
		>
			{href}
		</a>
	);
}

export function ProfilePane({
	highlightId,
	links,
	onLinksChange,
	onCommitLinks,
}: {
	highlightId: string | null;
	links: LinkDraft;
	onLinksChange: (next: LinkDraft) => void;
	onCommitLinks: () => void;
}) {
	const me = useMe();
	const profile = useProfile();
	const upload = useUploadPicture();
	const remove = useRemovePicture();
	const pictureInput = useRef<HTMLInputElement>(null);
	const chooseButton = useRef<HTMLButtonElement>(null);
	const ready = me.status === "authenticated" && profile.isSuccess;
	useShowSetting(highlightId, ready);
	const user = me.status === "authenticated" ? me.user : null;
	const saved = profile.data;
	const pictureError = upload.error ?? remove.error;
	const github = checkLink(GithubLink, links.github);
	const website = checkLink(WebsiteLink, links.website);
	const commitOnEnter = (event: { key: string }) => {
		if (event.key === "Enter") onCommitLinks();
	};

	function signInValue(controlId: string): string {
		if (controlId === "display-name")
			return saved?.displayName ?? user?.displayName ?? "";
		if (controlId === "email") return saved?.email ?? "Not provided";
		if (controlId === "sign-in-name") return user?.signInName ?? "Not provided";
		if (controlId === "workspace-label")
			return saved?.workspaceLabel ?? "Not created yet";
		return "";
	}

	function editable(controlId: string) {
		switch (controlId) {
			case "profile-picture":
				return (
					<div className="grid gap-2">
						<span className={LABEL_CLASS}>Profile picture</span>
						<div className="flex flex-wrap items-center gap-3">
							{saved?.picture ? (
								<img
									src={saved.picture}
									alt="Your profile"
									data-testid="profile-picture"
									className="size-12 shrink-0 rounded-full border border-line object-cover"
								/>
							) : (
								<span
									className="grid size-12 shrink-0 place-items-center rounded-full border border-line bg-surface-sunken text-[15px] font-semibold text-ink"
									data-testid="account-initials"
									aria-hidden="true"
								>
									{initials(user?.displayName ?? "")}
								</span>
							)}
							{/* The native input is hidden; the button opens its file picker. */}
							<input
								ref={pictureInput}
								type="file"
								accept="image/png,image/jpeg"
								hidden
								data-testid="profile-picture-input"
								onChange={(event) => {
									const file = event.target.files?.[0];
									if (file) upload.mutate(file);
									event.target.value = "";
								}}
							/>
							<Button
								ref={chooseButton}
								variant="secondary"
								data-testid="profile-picture-choose"
								loading={upload.isPending}
								onClick={() => pictureInput.current?.click()}
							>
								Choose picture…
							</Button>
							{saved?.picture ? (
								<Button
									variant="secondary"
									onClick={() =>
										remove.mutate(undefined, {
											// The button goes away with the picture; keep focus beside it.
											onSuccess: () => chooseButton.current?.focus(),
										})
									}
									loading={remove.isPending}
								>
									Remove picture
								</Button>
							) : null}
						</div>
						<p className="pk-hint m-0 text-[12px] leading-4 text-ink-muted">
							A PNG or JPEG of up to 1 MiB. It is saved as soon as you choose it and
							shows in the account menu.
						</p>
						{pictureError ? (
							<p
								className="pk-text-body m-0 text-status-error"
								data-testid="profile-picture-error"
							>
								{pictureError instanceof Error
									? pictureError.message
									: "The picture was not saved."}
							</p>
						) : null}
					</div>
				);
			case "github":
				return (
					<div className="grid gap-1">
						<TextField
							id="profile-github"
							label="GitHub"
							hint="Your GitHub username or an https:// link to your profile."
							value={links.github ?? saved?.github ?? ""}
							error={github.error}
							autoComplete="off"
							onChange={(event) =>
								onLinksChange({ ...links, github: event.target.value })
							}
							onBlur={onCommitLinks}
							onKeyDown={commitOnEnter}
						/>
						{saved?.github ? (
							<SavedLink href={githubHref(saved.github)} testId="profile-github-link" />
						) : null}
					</div>
				);
			case "website":
				return (
					<div className="grid gap-1">
						<TextField
							id="profile-website"
							label="Personal site"
							hint="One https:// link."
							value={links.website ?? saved?.website ?? ""}
							error={website.error}
							autoComplete="off"
							onChange={(event) =>
								onLinksChange({ ...links, website: event.target.value })
							}
							onBlur={onCommitLinks}
							onKeyDown={commitOnEnter}
						/>
						{saved?.website ? (
							<SavedLink href={saved.website} testId="profile-website-link" />
						) : null}
					</div>
				);
			default:
				return null;
		}
	}

	const [signIn, about, linked] = PROFILE?.groups ?? [];
	const [picture, ...linkControls] = about?.controls ?? [];

	return (
		<section className="grid gap-6" aria-labelledby="settings-section-profile">
			<h2 id="settings-section-profile" className="pk-text-heading text-ink">
				Profile
			</h2>
			{me.status === "loading" || profile.isPending ? (
				<p className="pk-text-body text-ink-muted">Loading your profile…</p>
			) : null}
			{me.status !== "loading" && !profile.isPending && !ready ? (
				<p className="pk-text-body text-status-error" data-testid="account-error">
					Your account details could not be loaded.
				</p>
			) : null}
			{ready ? (
				<>
					<section
						className="pk-settings-group grid gap-4"
						aria-labelledby="settings-profile-signin"
					>
						<h3
							id="settings-profile-signin"
							className="pk-text-body font-semibold text-ink"
						>
							{signIn?.title}
						</h3>
						<p className="pk-text-compact m-0 text-ink-muted">
							These come from the institution sign-in and cannot be changed here.
						</p>
						<dl className="m-0 grid gap-4" data-testid="profile-signin">
							{signIn?.controls.map((control) => (
								<ControlFrame
									key={control.id}
									control={control}
									highlighted={highlightId === control.id}
								>
									<dt className="pk-text-label flex min-w-0 items-center gap-1 text-ink-muted">
										{control.label}
										{control.id === "workspace-label" ? (
											<Toggletip label={control.label}>
												The name of your workspace machine. It is part of your preview
												addresses, and administrators see it.
											</Toggletip>
										) : null}
									</dt>
									<dd className="pk-text-body pk-settings-value m-0 text-ink">
										{signInValue(control.id)}
									</dd>
								</ControlFrame>
							))}
						</dl>
					</section>
					<section
						className="pk-settings-group grid gap-4"
						aria-labelledby="settings-profile-about"
					>
						<h3
							id="settings-profile-about"
							className="pk-text-body font-semibold text-ink"
						>
							{about?.title}
						</h3>
						<p className="pk-text-compact m-0 text-ink-muted">All optional.</p>
						{picture ? (
							<ControlFrame control={picture} highlighted={highlightId === picture.id}>
								{editable(picture.id)}
							</ControlFrame>
						) : null}
						{linkControls.map((control) => (
							<ControlFrame
								key={control.id}
								control={control}
								highlighted={highlightId === control.id}
							>
								{editable(control.id)}
							</ControlFrame>
						))}
					</section>
					<section
						className="pk-settings-group grid gap-4"
						aria-labelledby="settings-profile-linked"
					>
						<div className="flex min-w-0 items-center gap-1">
							<h3
								id="settings-profile-linked"
								className="pk-text-body font-semibold text-ink"
								tabIndex={-1}
							>
								{linked?.title}
							</h3>
							<Toggletip label={linked?.title ?? "Linked accounts"}>
								If you open Portikus both from your course and by signing in with your
								SSO account, linking them opens the same account and workspace from
								both.
							</Toggletip>
						</div>
						{linked?.controls.map((control) => (
							<ControlFrame
								key={control.id}
								control={control}
								highlighted={highlightId === control.id}
							>
								<LinkedAccounts />
							</ControlFrame>
						))}
					</section>
				</>
			) : null}
		</section>
	);
}
