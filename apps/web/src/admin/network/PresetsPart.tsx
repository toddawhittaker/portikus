import type { AdminEgressView, EgressPresetId } from "@portikus/contracts";
import { Checkbox, useToast } from "@portikus/ui";
import { Part } from "./Part.js";
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
		<Part
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
							className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2"
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
							<details className="text-right text-[12px]">
								<summary className="pk-focus-ring ml-auto w-fit cursor-pointer rounded-xs text-ink-muted">
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
		</Part>
	);
}
