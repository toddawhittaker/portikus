import type { AdminEgressView, EgressPresetId } from "@portikus/contracts";
import { Checkbox, Icon, useToast } from "@portikus/ui";
import { AdminGroup } from "../AdminSection.js";
import { egressErrorText, useEgressWrite } from "./queries.js";

/** One-click presets; each covers its hosts and their subdomains (SPEC.md section 20.1). */
export function PresetsPart({ view }: { view: AdminEgressView }) {
	const write = useEgressWrite();
	const toast = useToast();

	function toggle(id: EgressPresetId, label: string, on: boolean) {
		// Busy rather than natively disabled, so focus stays on the box.
		if (write.isPending) return;
		// Kept in catalogue order, so the saved list reads the same as the page.
		const presets = view.presetCatalog
			.map((preset) => preset.id)
			.filter((each) => (each === id ? on : view.presets.includes(each)));
		write.mutate(
			{ kind: "presets", version: view.version, presets },
			{
				onSuccess: () =>
					toast.show({
						tone: "success",
						title: `${label} ${on ? "turned on" : "turned off"}`,
					}),
			},
		);
	}

	return (
		<AdminGroup
			level={4}
			id="egress-presets-title"
			title="Presets"
			description="Turn on the services your courses use. Each covers the listed sites and every name under them."
		>
			{write.isError ? (
				<p className="m-0 text-[13px] text-status-error" role="alert">
					{egressErrorText(write.error)}
				</p>
			) : null}
			<ul className="m-0 list-none divide-y divide-line border-y border-line p-0">
				{view.presetCatalog.map((preset) => {
					const on = view.presets.includes(preset.id);
					return (
						<li
							key={preset.id}
							className="pk-preset-row flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2"
							data-testid={`egress-preset-${preset.id}`}
							data-on={on}
						>
							<Checkbox
								className="min-w-0"
								label={preset.label}
								checked={on}
								ariaDisabled={write.isPending}
								onChange={(event) =>
									toggle(preset.id, preset.label, event.target.checked)
								}
							/>
							<details className="group text-right text-[12px]">
								<summary className="pk-preset-sites pk-focus-ring ml-auto flex w-fit cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden rounded-xs text-ink-muted">
									<Icon
										name="chevron-right"
										size="sm"
										className="flex-none group-open:rotate-90"
									/>
									<span className="sr-only">{preset.label}: </span>
									{preset.hosts.length === 1
										? "1 site"
										: `${preset.hosts.length} sites`}
								</summary>
								<ul className="m-0 mt-1 list-none p-0 font-mono text-ink">
									{preset.hosts.map((host) => (
										<li key={host} className="[overflow-wrap:anywhere]">
											{host}
										</li>
									))}
								</ul>
							</details>
						</li>
					);
				})}
			</ul>
		</AdminGroup>
	);
}
