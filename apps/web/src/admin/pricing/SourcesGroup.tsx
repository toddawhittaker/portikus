import {
	type AiSettingsView,
	DEFAULT_PRICE_SOURCES,
	isAiBaseUrl,
	MAX_AI_PRICE_SOURCES,
	type UpdateAiSettingsRequest,
} from "@portikus/contracts";
import { Button, Checkbox, IconButton, TextField, useToast } from "@portikus/ui";
import { type FormEvent, useState } from "react";
import { errorText } from "../../api/request.js";
import { AdminGroup } from "../AdminSection.js";
import { useUpdateAi } from "../ai/queries.js";
import { useProxyHosts } from "./queries.js";
import { SOURCES_HEADING } from "./RunGroup.js";
import { listedHosts, unlistedSourceHosts } from "./text.js";

/**
 * The pricing pages a check reads (SPEC.md section 20.4). An empty saved list
 * means the providers' own pages, shown here so they can be edited.
 */
export function SourcesGroup({ view }: { view: AiSettingsView }) {
	const toast = useToast();
	const save = useUpdateAi();
	const proxy = useProxyHosts();
	const usingDefaults = view.priceSources.length === 0;
	const [sources, setSources] = useState<string[]>(
		usingDefaults ? [...DEFAULT_PRICE_SOURCES] : view.priceSources,
	);
	const [adding, setAdding] = useState("");
	const [addError, setAddError] = useState<string | undefined>();
	const [addHost, setAddHost] = useState(true);

	const listed = proxy.data
		? listedHosts([proxy.data.operatorHosts, proxy.data.hosts])
		: null;
	const offer = unlistedSourceHosts(sources, listed);
	const dirty =
		JSON.stringify(sources) !==
		JSON.stringify(usingDefaults ? DEFAULT_PRICE_SOURCES : view.priceSources);
	const full = sources.length >= MAX_AI_PRICE_SOURCES;

	function onAdd(event: FormEvent) {
		event.preventDefault();
		const address = adding.trim();
		if (!isAiBaseUrl(address)) {
			setAddError("Give the pricing page's https:// address, by host name.");
			return;
		}
		if (sources.includes(address)) {
			setAddError("That page is already in the list.");
			return;
		}
		setAddError(undefined);
		setSources((s) => [...s, address]);
		setAdding("");
	}

	function onSave() {
		const body: UpdateAiSettingsRequest = { priceSources: sources };
		if (offer.length > 0 && addHost) body.addProxyHost = true;
		save.mutate(body, {
			onSuccess: () => {
				void proxy.refetch();
				toast.show({ tone: "success", title: "Sources saved" });
			},
		});
	}

	return (
		<AdminGroup
			id={SOURCES_HEADING}
			title="Sources"
			testId="pricing-sources"
			description={
				usingDefaults
					? "The providers' own API pricing pages. Change the list to read other pages."
					: "The pages each check reads. The server fetches them itself through its proxy."
			}
		>
			<ul className="m-0 grid list-none gap-1 p-0" data-testid="pricing-source-list">
				{sources.map((source) => (
					<li key={source} className="flex min-w-0 items-center gap-2">
						<code className="pk-mono-body min-w-0 flex-1 [overflow-wrap:anywhere]">
							{source}
						</code>
						<IconButton
							icon="x"
							size="sm"
							label={`Remove ${source}`}
							onClick={() => setSources((s) => s.filter((x) => x !== source))}
						/>
					</li>
				))}
				{sources.length === 0 ? (
					<li className="pk-muted text-[14px]">
						No pages. Saving an empty list uses the providers' own pages.
					</li>
				) : null}
			</ul>
			<form className="flex flex-wrap items-end gap-2" noValidate onSubmit={onAdd}>
				<div className="min-w-0 flex-[1_1_18rem]">
					<TextField
						id="pricing-source-new"
						label="Add a page"
						mono
						value={adding}
						error={addError}
						hint={
							full ? `The list holds at most ${MAX_AI_PRICE_SOURCES} pages.` : undefined
						}
						autoComplete="off"
						spellCheck={false}
						onChange={(e) => setAdding(e.target.value)}
					/>
				</div>
				<Button type="submit" aria-disabled={full || undefined} disabled={full}>
					Add
				</Button>
			</form>
			{offer.length > 0 ? (
				<div className="grid gap-1" data-testid="pricing-proxy-offer">
					<Checkbox
						label={
							<>
								Portikus will also allow the server to reach{" "}
								{offer.map((host, i) => (
									<span key={host}>
										{i > 0 ? (i === offer.length - 1 ? " and " : ", ") : null}
										<code className="pk-mono-body [overflow-wrap:anywhere]">
											{host}
										</code>
									</span>
								))}{" "}
								on port 443
							</>
						}
						description="The server reaches outside pages only through its proxy. Adding a host runs as a site change; the host is allowed once that change finishes."
						checked={addHost}
						onChange={(e) => setAddHost(e.target.checked)}
					/>
				</div>
			) : null}
			{save.isError ? (
				<p className="m-0 text-[13px] text-status-error" role="alert">
					{errorText(save.error)}
				</p>
			) : null}
			<div>
				<Button
					variant="primary"
					data-testid="pricing-sources-save"
					loading={save.isPending}
					aria-disabled={(!dirty && !(offer.length > 0 && addHost)) || undefined}
					onClick={() => {
						if (dirty || (offer.length > 0 && addHost)) onSave();
					}}
				>
					Save sources
				</Button>
			</div>
		</AdminGroup>
	);
}
