import type { AdminEgressView, EgressPresetId } from "@portikus/contracts";
import { Checkbox, useToast } from "@portikus/ui";
import { egressErrorText, useEgressWrite } from "./queries.js";

/** One-click presets; each covers its hosts and their subdomains (SPEC.md section 20.1). */
export function PresetsCard({ view }: { view: AdminEgressView }) {
	const write = useEgressWrite();
	const toast = useToast();

	function toggle(id: EgressPresetId, label: string, on: boolean) {
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
		<section className="pk-card p-6" aria-labelledby="egress-presets-title">
			<h3 className="pk-text-heading m-0" id="egress-presets-title">
				Presets
			</h3>
			<p className="pk-text-body pk-muted mt-1 mb-0">
				Turn on the services your courses use. Each covers the listed sites and every
				name under them.
			</p>
			{write.isError ? (
				<p className="m-0 mt-3 text-[13px] text-status-error" role="alert">
					{egressErrorText(write.error)}
				</p>
			) : null}
			<ul className="m-0 mt-4 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-start gap-3 p-0">
				{view.presetCatalog.map((preset) => {
					const on = view.presets.includes(preset.id);
					return (
						<li
							key={preset.id}
							className={`rounded-md border p-3 ${
								on ? "border-accent bg-accent-soft" : "border-line bg-surface"
							}`}
							data-testid={`egress-preset-${preset.id}`}
							data-on={on}
						>
							<Checkbox
								label={<span className="font-semibold">{preset.label}</span>}
								checked={on}
								disabled={write.isPending}
								onChange={(event) =>
									toggle(preset.id, preset.label, event.target.checked)
								}
							/>
							<details className="mt-2 ml-6 text-[12px]">
								<summary className="pk-focus-ring w-fit cursor-pointer rounded-xs text-ink-muted">
									{preset.hosts.length === 1
										? "1 site"
										: `${preset.hosts.length} sites`}
								</summary>
								<ul className="m-0 mt-1 list-none p-0 font-mono text-ink">
									{preset.hosts.map((host) => (
										<li key={host}>{host}</li>
									))}
								</ul>
							</details>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
