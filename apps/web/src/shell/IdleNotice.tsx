import type { Workspace } from "@portikus/contracts";
import { Button, Icon } from "@portikus/ui";
import { type RefObject, useEffect, useRef, useState } from "react";
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
 * page answers it too. When it goes, focus returns to where it was, or to
 * `fallbackFocus` when that element is gone.
 */
export function IdleNotice({
	deadline,
	minutes,
	onKeepWorking,
	fallbackFocus,
}: {
	deadline: string;
	minutes: number | null;
	onKeepWorking: () => void;
	fallbackFocus?: RefObject<HTMLElement | null>;
}) {
	const countdown = useCountdown(deadline);
	const button = useRef<HTMLButtonElement>(null);
	const notice = useRef<HTMLDivElement>(null);
	const shown = countdown !== null;

	useEffect(() => {
		if (!shown) return;
		const before = document.activeElement;
		const container = notice.current;
		button.current?.focus();
		return () => {
			const active = document.activeElement;
			const stranded =
				!active || active === document.body || container?.contains(active) === true;
			if (!stranded) return;
			const target =
				before instanceof HTMLElement && before !== document.body && before.isConnected
					? before
					: fallbackFocus?.current;
			target?.focus({ preventScroll: true });
		};
	}, [shown, fallbackFocus]);

	if (!countdown) return null;

	return (
		<div
			ref={notice}
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

// Allows for the worker's polling and a little clock skew.
const DEADLINE_SLACK_MS = 60_000;

/**
 * Remembers, for the page's life, that idle stop stopped the workspace, so
 * the stopped screen can say why. The view does not say who stopped it, so a
 * stop that begins well before the idle deadline (the student's own Stop, or
 * the disconnect grace period) is not called an idle stop. Returns the idle
 * minutes (null when unknown) once it has stopped, else undefined.
 */
export function useIdleStopReason(
	workspace: Workspace | null,
): { minutes: number | null } | undefined {
	const asked = useRef<{ minutes: number | null; deadline: number } | null>(null);
	// The cause is judged once, when the stop is first seen.
	const decided = useRef(false);
	const [reason, setReason] = useState<{ minutes: number | null } | undefined>();

	useEffect(() => {
		if (!workspace) return;
		if (workspace.idleStopAt) {
			asked.current = {
				minutes: idleMinutes(workspace),
				deadline: Date.parse(workspace.idleStopAt),
			};
		} else if (workspace.state === "running" && workspace.desiredState === "running") {
			// Answered, or started again.
			asked.current = null;
			decided.current = false;
			setReason(undefined);
			return;
		}
		if (workspace.state !== "stopping" && workspace.state !== "stopped") return;
		if (decided.current || !asked.current) return;
		decided.current = true;
		if (Date.now() >= asked.current.deadline - DEADLINE_SLACK_MS) {
			setReason({ minutes: asked.current.minutes });
		}
	}, [workspace]);

	return reason;
}
