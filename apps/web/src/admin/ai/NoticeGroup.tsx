import { AI_NOTICE_VERSION, type AiSettingsView } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { AdminGroup as Group } from "../AdminSection.js";
import { useAcceptNotice } from "./queries.js";
import { noticeAccepted } from "./text.js";

const WHEN = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** The privacy notice text (SPEC.md sections 20.4 and 24). */
function NoticeText() {
	return (
		<div className="grid max-w-[72ch] gap-3 text-[14px]" data-testid="ai-notice-text">
			<section aria-labelledby="ai-notice-sent" className="grid gap-1">
				<h4 id="ai-notice-sent" className="pk-group-label m-0">
					What leaves this server
				</h4>
				<p className="m-0">
					When someone asks the assistant, the results of the tools it uses go to the
					provider you set below. Those results can include people's real names, course
					names, workspace and process details, and log lines.
				</p>
			</section>
			<section aria-labelledby="ai-notice-kept" className="grid gap-1">
				<h4 id="ai-notice-kept" className="pk-group-label m-0">
					What never leaves
				</h4>
				<p className="m-0">
					File contents, terminal output, students' chat prompts and secrets are never
					sent.
				</p>
			</section>
			<section aria-labelledby="ai-notice-stored" className="grid gap-1">
				<h4 id="ai-notice-stored" className="pk-group-label m-0">
					What is stored
				</h4>
				<p className="m-0">
					Conversations are stored in this site's database for 30 days, and only the
					person who had a conversation can see it. Backups taken in that time keep them
					until each backup expires.
				</p>
			</section>
			<section aria-labelledby="ai-notice-who" className="grid gap-1">
				<h4 id="ai-notice-who" className="pk-group-label m-0">
					Who the provider is
				</h4>
				<p className="m-0">
					A hosted provider is an outside party with its own terms. A model running on
					your institution's own network cannot be reached yet.
				</p>
			</section>
		</div>
	);
}

/** The notice, in full until accepted, then behind a disclosure under who accepted it. */
export function NoticeGroup({ view }: { view: AiSettingsView }) {
	const accept = useAcceptNotice();
	const accepted = noticeAccepted(view);
	return (
		<Group
			id="ai-notice-title"
			title="Privacy notice"
			testId="ai-notice"
			description={accepted ? undefined : "Read this before turning the assistant on."}
		>
			{accepted && view.noticeAcceptedAt ? (
				<>
					<p className="m-0 text-[14px]" data-testid="ai-notice-accepted">
						Accepted by {view.noticeAcceptedBy ?? "an administrator"} on{" "}
						<time dateTime={view.noticeAcceptedAt}>
							{WHEN.format(new Date(view.noticeAcceptedAt))}
						</time>
						.
					</p>
					<details>
						<summary className="pk-link w-fit cursor-pointer text-[13px]">
							Read the notice again
						</summary>
						<div className="pt-3">
							<NoticeText />
						</div>
					</details>
				</>
			) : (
				<>
					<NoticeText />
					<div className="flex flex-wrap items-center gap-3">
						<Button
							variant="primary"
							data-testid="ai-notice-accept"
							loading={accept.isPending}
							onClick={() => accept.mutate(AI_NOTICE_VERSION)}
						>
							I have read this
						</Button>
					</div>
					{accept.isError ? (
						<p className="m-0 text-[13px] text-status-error" role="alert">
							{errorText(accept.error)}
						</p>
					) : null}
				</>
			)}
		</Group>
	);
}
