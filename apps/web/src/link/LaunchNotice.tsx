import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	ConfirmDialogTrigger,
	Icon,
	IconButton,
} from "@portikus/ui";
import { useState } from "react";
import { useMyLinks, useUnlink } from "../settings/profileQueries.js";

const DISMISSED_KEY = "pk-launch-notice-dismissed";

function readDismissed(): boolean {
	try {
		return sessionStorage.getItem(DISMISSED_KEY) === "1";
	} catch {
		return false;
	}
}

function saveDismissed() {
	try {
		sessionStorage.setItem(DISMISSED_KEY, "1");
	} catch {
		// Storage may be blocked; the notice then only hides until a reload.
	}
}

/**
 * After a launch into a linked account, says whose account opened, so a
 * student sent into someone else's account can undo the link.
 */
export function LaunchNotice({ displayName }: { displayName: string }) {
	const links = useMyLinks();
	const unlink = useUnlink();
	const [dismissed, setDismissed] = useState(readDismissed);
	const [confirming, setConfirming] = useState(false);

	const launch = dismissed ? null : (links.data?.launch ?? null);
	const message = launch
		? `Opened from ${launch.platformName} as ${displayName}. Not you?`
		: "";

	return (
		<>
			{/* Mounted before the text arrives, so filling it is announced (review A1). */}
			<p className="sr-only" role="status" data-testid="launch-notice-status">
				{message}
			</p>
			{launch ? (
				<section
					className="pk-notice pk-notice--warning"
					aria-label="Course sign-in"
					data-testid="launch-notice"
				>
					<span className="pk-notice-icon">
						<Icon name="info" size="md" />
					</span>
					<div className="pk-notice-main">
						<p className="pk-notice-body">{message}</p>
						{unlink.error ? (
							<p className="pk-notice-body text-status-error" role="alert">
								{unlink.error.message}
							</p>
						) : null}
					</div>
					<div className="pk-notice-actions">
						<ConfirmDialogRoot open={confirming} onOpenChange={setConfirming}>
							<ConfirmDialogTrigger asChild>
								<Button variant="secondary" size="sm">
									Unlink <span className="sr-only">this course sign-in</span>
								</Button>
							</ConfirmDialogTrigger>
							<ConfirmDialog
								title="Unlink this course sign-in?"
								description={`Your ${launch.platformName} sign-in will stop opening ${displayName}'s account, and you will be signed out here. Open Portikus again from your course to continue with your course account.`}
								confirmLabel="Unlink"
								testId="launch-unlink-confirm"
								pending={unlink.isPending}
								onConfirm={() =>
									unlink.mutate(launch.courseUserId, {
										onSettled: () => setConfirming(false),
									})
								}
							/>
						</ConfirmDialogRoot>
						<IconButton
							icon="x"
							size="sm"
							label="Dismiss"
							onClick={() => {
								saveDismissed();
								setDismissed(true);
								// The notice is gone, so focus goes to the account menu above it.
								document.querySelector<HTMLElement>('[data-testid="me"]')?.focus();
							}}
						/>
					</div>
				</section>
			) : null}
		</>
	);
}
