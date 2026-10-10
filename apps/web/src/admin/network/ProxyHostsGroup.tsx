import { AdminProxyHosts, ProxyHostName, SiteJobView } from "@portikus/contracts";
import { Button, TextField } from "@portikus/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, errorText, sendJson } from "../../api/request.js";
import { announced } from "../../common/announced.js";
import { AdminGroup } from "../AdminSection.js";
import { SiteJobLine, useSiteList } from "../site-job.js";

/** The contracts' message for a host name, or null when the API would take it. */
function hostError(
	value: string,
	existing: string[],
	operator: string[],
): string | null {
	const host = value.trim().toLowerCase();
	if (host === "") return "Enter a host name.";
	const parsed = ProxyHostName.safeParse(host);
	if (!parsed.success) return parsed.error.issues[0]?.message ?? "Not valid.";
	if (existing.includes(host)) return "That host is already in the list.";
	if (operator.includes(host)) return "The operator's list already allows that host.";
	return null;
}

/**
 * Hosts the API may reach through its egress proxy, on port 443 by CONNECT
 * only (SPEC.md section 20.1, ADR 0059). Every change is a root job; the
 * operator's own hosts show read-only.
 */
export function ProxyHostsGroup() {
	const { query, job, busy, follow } = useSiteList(
		"proxy-hosts",
		"/admin/proxy-hosts",
		AdminProxyHosts,
	);
	const client = useQueryClient();
	const save = useMutation({
		mutationFn: (hosts: string[]) =>
			sendJson(SiteJobView, "/admin/proxy-hosts", { hosts }, "PUT"),
		onSuccess: (queued) => {
			follow(queued);
			void client.invalidateQueries({ queryKey: ["admin", "proxy-hosts"] });
		},
	});
	const [value, setValue] = useState("");
	const [checked, setChecked] = useState(false);
	const data = query.data;

	// Without the site job (a development install) the group is left out.
	const off = query.error instanceof ApiError && query.error.status === 404;
	if (!data && (off || !query.isError)) return null;
	if (!data) {
		return (
			<AdminGroup
				id="proxy-hosts-title"
				title="Allowed API hosts"
				testId="proxy-hosts-group"
			>
				<p className="pk-text-compact m-0 text-status-error" role="alert">
					{errorText(query.error)}
				</p>
			</AdminGroup>
		);
	}

	const error = checked ? hostError(value, data.hosts, data.operatorHosts) : null;

	function add(event: FormEvent) {
		event.preventDefault();
		if (!data || busy) return;
		setChecked(true);
		if (hostError(value, data.hosts, data.operatorHosts)) return;
		save.mutate([...data.hosts, value.trim().toLowerCase()], {
			onSuccess: () => {
				setValue("");
				setChecked(false);
			},
		});
	}

	return (
		<AdminGroup
			id="proxy-hosts-title"
			title="Allowed API hosts"
			description="Internet hosts the Portikus server itself may reach, such as an AI service or a sign-in provider. This is separate from the workspace rules above. Each host is reached on port 443 only."
			testId="proxy-hosts-group"
		>
			<form className="flex flex-wrap items-start gap-3" noValidate onSubmit={add}>
				<TextField
					id="proxy-host-value"
					label="Host name"
					mono
					autoComplete="off"
					spellCheck={false}
					data-testid="proxy-host-value"
					value={value}
					error={announced(error)}
					onChange={(event) => setValue(event.target.value)}
				/>
				<Button
					type="submit"
					variant="primary"
					iconStart="plus"
					className="mt-6"
					data-testid="proxy-host-add"
					loading={save.isPending}
					aria-disabled={busy ? true : undefined}
				>
					Allow host
				</Button>
			</form>
			{save.isError ? (
				<p className="pk-text-compact m-0 text-status-error" role="alert">
					{errorText(save.error)}
				</p>
			) : null}
			{/* Always mounted, so each change of the job's state is read out. */}
			<div role="status" data-testid="proxy-hosts-job">
				<SiteJobLine job={job} />
			</div>
			<HostList
				hosts={data.hosts}
				busy={busy || save.isPending}
				onRemove={(host) => save.mutate(data.hosts.filter((h) => h !== host))}
			/>
			{data.operatorHosts.length > 0 ? (
				<div className="grid gap-2">
					<h4 className="pk-text-compact m-0 font-semibold text-ink-muted">
						Set by the operator
					</h4>
					<ul className="m-0 grid gap-1 pl-5" data-testid="proxy-hosts-operator">
						{data.operatorHosts.map((host) => (
							<li key={host} className="font-mono text-[13px]">
								{host}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</AdminGroup>
	);
}

function HostList({
	hosts,
	busy,
	onRemove,
}: {
	hosts: string[];
	busy: boolean;
	onRemove: (host: string) => void;
}) {
	if (hosts.length === 0) {
		return (
			<p className="pk-text-compact pk-muted m-0" data-testid="proxy-hosts-empty">
				No hosts have been added here.
			</p>
		);
	}
	return (
		<div className="pk-table-wrap">
			<table className="pk-table" data-testid="proxy-hosts-list">
				<caption className="sr-only">Hosts added on this page</caption>
				<thead>
					<tr>
						<th scope="col">Host</th>
						<th scope="col">
							<span className="sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{hosts.map((host) => (
						<tr key={host} data-testid="proxy-hosts-row">
							<td>
								<span className="font-mono [overflow-wrap:anywhere]">{host}</span>
							</td>
							<td className="text-right whitespace-nowrap">
								<Button
									size="sm"
									variant="quiet"
									aria-label={`Remove ${host}`}
									aria-disabled={busy ? true : undefined}
									onClick={() => {
										if (!busy) onRemove(host);
									}}
								>
									Remove
								</Button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
