import { ReinstallNote, reinstallCommand } from "@portikus/contracts";
import { Button, Icon, IconButton, useToast } from "@portikus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import { z } from "zod";
import { request } from "../api/request.js";
import { useFocusFallback } from "./useFocusFallback.js";

export const REINSTALL_TITLE =
	"Packages you had installed with sudo apt were removed when your workspace was rebuilt";

function noteKey(workspaceId: string) {
	return ["workspaces", workspaceId, "reinstall-note"];
}

/**
 * The packages a rebuild removed, shared by the notice and the page's
 * always-mounted status region through one cached query.
 */
export function useReinstallPackages(workspaceId: string, running: boolean): string[] {
	const note = useQuery({
		queryKey: noteKey(workspaceId),
		queryFn: () => request(ReinstallNote, `/workspaces/${workspaceId}/reinstall-note`),
		enabled: running,
		// Asked again each time the workspace starts, which is when a rebuild shows.
		refetchOnWindowFocus: false,
		// The agent may still be starting when the workspace first reads running.
		retry: 4,
	});
	return note.data?.packages ?? [];
}

/** The words for the page's always-mounted status region. */
export function reinstallAnnouncement(packages: string[]): string {
	if (packages.length === 0) return "";
	return `${REINSTALL_TITLE}: ${packages.join(", ")}.`;
}

/**
 * After a rebuild, lists the packages the student had added with apt that
 * are gone now, with the line that puts them back (SPEC.md §22.3, ADR 0042).
 * Dismissing it asks the workspace to forget the list's old image, so it
 * stays gone.
 */
export function ReinstallNotice({
	workspaceId,
	running,
	fallbackFocus,
}: {
	workspaceId: string;
	running: boolean;
	/** Takes focus once the notice is dismissed. */
	fallbackFocus?: RefObject<HTMLElement | null>;
}) {
	const queryClient = useQueryClient();
	const toast = useToast();
	const ref = useFocusFallback<HTMLDivElement>(fallbackFocus);
	const packages = useReinstallPackages(workspaceId, running);
	const dismiss = useMutation({
		mutationFn: () =>
			request(z.unknown(), `/workspaces/${workspaceId}/reinstall-note/dismiss`, {
				method: "POST",
			}),
		onSuccess: () => {
			queryClient.setQueryData(noteKey(workspaceId), { packages: [] });
			fallbackFocus?.current?.focus();
		},
		onError: () => {
			toast.show({ tone: "danger", title: "The notice could not be dismissed." });
		},
	});

	if (!running || packages.length === 0) return null;
	const command = reinstallCommand(packages);

	async function copy() {
		try {
			await navigator.clipboard.writeText(command);
			toast.show({ tone: "success", title: "Command copied" });
		} catch {
			toast.show({
				tone: "danger",
				title: "Could not copy. Select the command instead.",
			});
		}
	}

	return (
		<div ref={ref} className="pk-notice" data-testid="reinstall-notice">
			<span className="pk-notice-icon">
				<Icon name="info" size="md" />
			</span>
			<div className="pk-notice-main">
				<p className="pk-notice-title">{REINSTALL_TITLE}</p>
				<p className="pk-notice-body" data-testid="reinstall-packages">
					{packages.join(", ")}
				</p>
				<p className="pk-notice-body">Reinstall them with:</p>
				<code className="pk-techdetail select-all" data-testid="reinstall-command">
					{command}
				</code>
			</div>
			<div className="pk-notice-actions">
				<Button size="sm" data-testid="reinstall-copy" onClick={() => void copy()}>
					Copy command
				</Button>
				<IconButton
					icon="x"
					size="sm"
					label="Dismiss the reinstall notice"
					data-testid="reinstall-dismiss"
					onClick={() => {
						if (!dismiss.isPending) dismiss.mutate();
					}}
				/>
			</div>
		</div>
	);
}
