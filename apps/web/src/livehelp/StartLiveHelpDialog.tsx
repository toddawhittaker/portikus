import type { LiveHelpAudienceCourse, Project } from "@portikus/contracts";
import { LIVE_HELP_MINUTES } from "@portikus/contracts";
import {
	Button,
	Dialog,
	DialogRoot,
	Select,
	type SelectGroup,
	Skeleton,
} from "@portikus/ui";
import { useState } from "react";
import { ApiError } from "../api/request.js";
import { DialogError } from "../common/DialogError.js";
import { useLiveHelpAudience, useStartLiveHelp } from "./queries.js";

/** One Select value names both the instructor and the course they help in. */
function choiceValue(courseId: string, userId: string): string {
	return `${courseId}/${userId}`;
}

/** Each course that has an instructor, as a group of choices. */
export function instructorGroups(audience: LiveHelpAudienceCourse[]): SelectGroup[] {
	return audience
		.filter((course) => course.instructors.length > 0)
		.map((course) => ({
			label: course.courseTitle,
			options: course.instructors.map((instructor) => ({
				value: choiceValue(course.courseId, instructor.userId),
				label: instructor.displayName,
			})),
		}));
}

/** The API's refusals, in words that say what to do next (SPEC.md §28). */
export function startError(error: unknown): ApiError | unknown {
	if (!(error instanceof ApiError)) return error;
	if (error.code === "LIVE_HELP_OPEN") {
		return new ApiError(
			error.status,
			"Live help is already open in your workspace. End it from the bar at the top of the page, then start again.",
			error.code,
		);
	}
	if (error.code === "VALIDATION_FAILED") {
		return new ApiError(
			error.status,
			`${error.message} The list has been read again; choose an instructor from it.`,
			error.code,
		);
	}
	return error;
}

/**
 * Ask one instructor of the student's courses for live help on one project
 * (ADR 0063). Before anything starts the dialog says what the instructor will
 * see, that typing is off, and what turning it on gives them.
 */
export function StartLiveHelpDialog({
	workspaceId,
	project,
	onClose,
}: {
	workspaceId: string;
	project: Project;
	onClose: () => void;
}) {
	const status = useLiveHelpAudience(workspaceId);
	const start = useStartLiveHelp(workspaceId, project.id);
	const groups = instructorGroups(status.data?.audience ?? []);
	const choices = groups.flatMap((group) => group.options);
	const [picked, setPicked] = useState<string | undefined>(undefined);
	// A single instructor is the only possible answer, so it is chosen already.
	const only = choices.length === 1 ? choices[0]?.value : undefined;
	const value = choices.some((choice) => choice.value === picked) ? picked : only;
	const open = status.data?.session ?? null;
	const canStart = !open && choices.length > 0;

	function submit() {
		if (!value) return;
		const [courseId = "", helperUserId = ""] = value.split("/");
		start.mutate({ courseId, helperUserId }, { onSuccess: onClose });
	}

	return (
		<DialogRoot open onOpenChange={(next) => !next && onClose()}>
			<Dialog
				testId="dialog-live-help"
				title={`Get live help on ${project.name}`}
				description="One instructor watches this project's terminals and the previews of anything running in your workspace with you, live. Typing stays off unless you turn it on."
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							{canStart ? "Cancel" : "Close"}
						</Button>
						{canStart ? (
							<Button
								data-testid="live-help-start"
								variant="primary"
								loading={start.isPending}
								aria-disabled={value ? undefined : true}
								aria-describedby={value ? undefined : "live-help-instructor-hint"}
								onClick={submit}
							>
								Start live help
							</Button>
						) : null}
					</>
				}
			>
				{status.isPending ? (
					<Skeleton />
				) : status.isError ? (
					<DialogError error={status.error} />
				) : open ? (
					<p className="pk-text-body m-0" data-testid="live-help-already-open">
						Live help with {open.helper.displayName} on {open.projectName} is already
						open. End it from the bar at the top of the page before you start another.
					</p>
				) : choices.length === 0 ? (
					<>
						<p className="pk-text-body m-0" data-testid="live-help-no-instructors">
							None of your courses has an instructor in Portikus yet, so there is no one
							to ask. Your instructor appears here after they open Portikus from the
							course.
						</p>
						{/* A refusal that emptied the list still says what happened. */}
						<DialogError error={startError(start.error)} />
					</>
				) : (
					<div className="grid gap-4">
						<dl className="pk-dl" data-testid="live-help-terms">
							<dt>What they see</dt>
							<dd>
								The terminals of {project.name}, and a preview of anything running in
								your workspace, from any project. A terminal shows them what is on its
								screen from when they open it, not its earlier output.
							</dd>
							<dt>Typing</dt>
							<dd>
								Off. They can only watch until you press <strong>Let them type</strong>{" "}
								in the bar at the top of the page. Only you can turn typing on or off.
							</dd>
							<dt>If they type</dt>
							<dd data-testid="live-help-typing-risk">
								They have a full shell as you. That includes your Git, Claude and SSH
								credentials, every file in your workspace, and your other terminals.
								Turn typing on only while you are watching.
							</dd>
							<dt>How long</dt>
							<dd>
								At most {LIVE_HELP_MINUTES} minutes. <strong>End live help</strong>{" "}
								stops it at once.
							</dd>
						</dl>
						<Select
							id="live-help-instructor"
							label="Who should help"
							placeholder="Choose an instructor"
							groups={groups}
							value={value}
							onValueChange={setPicked}
							hint={value ? undefined : "Choose an instructor first."}
						/>
						<DialogError error={startError(start.error)} />
					</div>
				)}
			</Dialog>
		</DialogRoot>
	);
}
