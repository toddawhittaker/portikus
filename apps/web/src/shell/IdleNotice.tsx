import type { Workspace } from "@portikus/contracts";
import { Button, Icon } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { useCountdown } from "./useCountdown.js";

/** The fixed wait between "Still working?" and the stop (ADR 0032). */
const ANSWER_MINUTES = 5;

/**
 * How long the workspace had been idle when the worker asked, in whole
 * minutes, or null when the times are missing. The worker sets the stop
 * time five minutes after it finds the workspace idle.
 */
export function idleMinutes(
	workspace: Pick<Workspace, "idleStopAt" | "lastActivityAt">,
): number | null {
	if (!workspace.idleStopAt || !workspace.lastActivityAt) return null;
	const span = Date.parse(workspace.idleStopAt) - Date.parse(workspace.lastActivityAt);
	if (Number.isNaN(span)) return null;
	return Math.max(1, Math.round(span / 60_000) - ANSWER_MINUTES);
}

function minutesText(minutes: number): string {
	return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * "Still working?" while idle stop is counting down (ADR 0032). Keep working
 * takes focus when the notice appears; any other key press or click in the
 * page answers it too.
 */
export function IdleNotice({
	deadline,
	minutes,
	onKeepWorking,
}: {
	deadline: string;
	minutes: number | null;
	onKeepWorking: () => void;
}) {
	const countdown = useCountdown(deadline);
	const button = useRef<HTMLButtonElement>(null);
	const shown = countdown !== null;

	useEffect(() => {
		if (shown) button.current?.focus();
	}, [shown]);

	if (!countdown) return null;

	return (
		<div
			className="pk-notice pk-notice--warning"
			role="status"
			aria-live="polite"
			data-testid="idle-notice"
		>
			<span className="pk-notice-icon">
				<Icon name="alert" size="md" />
			</span>
			<div className="pk-notice-main">
				<p className="pk-notice-title" id="idle-notice-title">
					Still working?
				</p>
				<p className="pk-notice-body" id="idle-notice-body">
					Your workspace will stop in <strong>{minutesText(countdown.minutes)}</strong>,
					at {countdown.at}
					{minutes === null
						? ", because nothing has happened in it for a while"
						: `, because nothing has happened in it for ${minutesText(minutes)}`}
					. Your files are saved; running terminals, agents and previews will end.
				</p>
			</div>
			<div className="pk-notice-actions">
				<Button
					ref={button}
					variant="secondary"
					size="sm"
					data-testid="idle-keep-working"
					aria-describedby="idle-notice-title idle-notice-body"
					onClick={onKeepWorking}
				>
					Keep working
				</Button>
			</div>
		</div>
	);
}

/**
 * Remembers, for the page's life, that the workspace was stopped while
 * "Still working?" was showing, so the stopped screen can say why. Returns
 * the idle minutes (null when unknown) once it has stopped, else undefined.
 */
export function useIdleStopReason(
	workspace: Workspace | null,
): { minutes: number | null } | undefined {
	const asked = useRef<{ minutes: number | null } | null>(null);
	const [reason, setReason] = useState<{ minutes: number | null } | undefined>();

	useEffect(() => {
		if (!workspace) return;
		if (workspace.idleStopAt) {
			asked.current = { minutes: idleMinutes(workspace) };
		} else if (workspace.state === "running" && workspace.desiredState === "running") {
			// Answered, or started again.
			asked.current = null;
			setReason(undefined);
			return;
		}
		if (
			asked.current &&
			(workspace.state === "stopping" || workspace.state === "stopped")
		) {
			setReason(asked.current);
		}
	}, [workspace]);

	return reason;
}
