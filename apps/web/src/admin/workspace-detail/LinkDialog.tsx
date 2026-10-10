import type { AdminUser } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField, useToast } from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import { isCourseAccount, sourceText } from "../markers.js";
import { useChangeLink, useCourseAccountSearch } from "./linkQueries.js";

/**
 * Pick a course account and link it to this SSO account, after a
 * confirmation that names both (SPEC.md section 20.1, ADR 0026).
 */
export function LinkDialog({
	user,
	open,
	onOpenChange,
}: {
	user: AdminUser;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const toast = useToast();
	const change = useChangeLink(user.id);
	const [text, setText] = useState("");
	const [pickedId, setPickedId] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const search = useCourseAccountSearch(text, open);
	// Already linked accounts are archived and hidden by the list; the route refuses the rest.
	const found = (search.data?.users ?? []).filter(
		(candidate) => isCourseAccount(candidate.issuer) && !candidate.markers.linked,
	);
	const picked = found.find((candidate) => candidate.id === pickedId) ?? null;

	function close(next: boolean) {
		if (change.isPending) return;
		if (!next) {
			setText("");
			setPickedId(null);
			setConfirming(false);
			change.reset();
		}
		onOpenChange(next);
	}

	function link() {
		if (!picked || change.isPending) return;
		change.mutate(
			{ courseUserId: picked.id, unlink: false },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: `${picked.displayName} linked to ${user.displayName}`,
					});
					close(false);
				},
			},
		);
	}

	const error = change.error ? (
		<p className="m-0 mt-3 text-status-error" role="alert" data-testid="link-error">
			{errorText(change.error)}
		</p>
	) : null;

	return (
		<DialogRoot open={open} onOpenChange={close}>
			{confirming && picked ? (
				<Dialog
					testId="link-dialog"
					title="Link these accounts?"
					description={`${picked.displayName} (${sourceText(picked.issuer)}) will be linked to ${user.displayName}. The course account is archived and signed out, and its next launch lands in ${user.displayName}.`}
					footer={
						<>
							<Button onClick={() => setConfirming(false)}>Back</Button>
							<Button
								variant="primary"
								data-testid="link-confirm"
								loading={change.isPending}
								onClick={link}
							>
								Link accounts
							</Button>
						</>
					}
				>
					{error}
				</Dialog>
			) : (
				<Dialog
					testId="link-dialog"
					title={`Link a course account to ${user.displayName}`}
					description="Search for the course account to link."
					footer={
						<>
							<Button onClick={() => close(false)}>Cancel</Button>
							<Button
								variant="primary"
								data-testid="link-next"
								aria-disabled={picked ? undefined : true}
								onClick={() => (picked ? setConfirming(true) : undefined)}
							>
								Continue
							</Button>
						</>
					}
				>
					<div className="flex flex-col gap-3">
						<TextField
							id="link-search"
							label="Search course accounts"
							autoComplete="off"
							data-testid="link-search"
							value={text}
							onChange={(event) => setText(event.target.value)}
						/>
						<fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
							<legend className="pk-text-compact pk-muted">Course accounts</legend>
							{found.map((candidate) => (
								<label
									key={candidate.id}
									className="pk-text-compact flex cursor-pointer items-center gap-2"
								>
									<input
										type="radio"
										name="link-course-account"
										checked={candidate.id === pickedId}
										onChange={() => setPickedId(candidate.id)}
									/>
									<span>
										{candidate.displayName}
										<span className="pk-muted">
											{` — ${sourceText(candidate.issuer)}`}
										</span>
									</span>
								</label>
							))}
							{found.length === 0 ? (
								<p className="pk-text-compact pk-muted m-0" role="status">
									{search.isLoading
										? "Searching…"
										: "No unlinked course accounts match."}
								</p>
							) : null}
						</fieldset>
					</div>
				</Dialog>
			)}
		</DialogRoot>
	);
}
