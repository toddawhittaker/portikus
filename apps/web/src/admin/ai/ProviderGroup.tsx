import {
	type AiSettingsView,
	isAiBaseUrl,
	MAX_AI_MODEL_CHARS,
	type ProviderKind,
	type UpdateAiSettingsRequest,
} from "@portikus/contracts";
import { Button, Checkbox, Select, TextField, useToast } from "@portikus/ui";
import { type FormEvent, useState } from "react";
import { errorText } from "../../api/request.js";
import { AdminGroup as Group } from "../AdminSection.js";
import { useAiModels, useUpdateAi } from "./queries.js";
import { baseUrlForKind, keyText, PROVIDERS, proxyOffer } from "./text.js";

const KIND_OPTIONS = (Object.keys(PROVIDERS) as ProviderKind[]).map((kind) => ({
	value: kind,
	label: PROVIDERS[kind].label,
}));

type Errors = { baseUrl?: string; model?: string; key?: string };

/** Which provider, where, which model, and its write-only key (SPEC.md section 20.4). */
export function ProviderGroup({ view }: { view: AiSettingsView }) {
	const toast = useToast();
	const save = useUpdateAi();
	const clear = useUpdateAi();
	const [kind, setKind] = useState<ProviderKind>(view.providerKind);
	const [baseUrl, setBaseUrl] = useState(
		view.baseUrl ?? PROVIDERS[view.providerKind].baseUrl,
	);
	const [model, setModel] = useState(view.model ?? "");
	const [replacing, setReplacing] = useState(!view.keySet);
	const [key, setKey] = useState("");
	const [addHost, setAddHost] = useState(true);
	const [errors, setErrors] = useState<Errors>({});

	const configured = view.keySet && view.baseUrl !== null;
	const models = useAiModels(configured, `${view.providerKind} ${view.baseUrl}`);
	const listed = models.data?.models ?? null;
	const offer = proxyOffer(baseUrl, view);

	function onKind(next: string) {
		const k = next as ProviderKind;
		setKind(k);
		setBaseUrl((current) => baseUrlForKind(k, current));
	}

	function check(): Errors {
		const out: Errors = {};
		if (!isAiBaseUrl(baseUrl.trim()))
			out.baseUrl =
				"Give the provider's https:// address by host name, such as https://api.openai.com/v1.";
		const m = model.trim();
		if (m === "") out.model = "Give the model's name.";
		else if (m.length > MAX_AI_MODEL_CHARS)
			out.model = `Keep the name under ${MAX_AI_MODEL_CHARS} characters.`;
		return out;
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const found = check();
		setErrors(found);
		const first = Object.keys(found)[0];
		if (first) {
			document
				.getElementById(`ai-${first === "baseUrl" ? "base-url" : first}`)
				?.focus();
			return;
		}
		const body: UpdateAiSettingsRequest = {
			providerKind: kind,
			baseUrl: baseUrl.trim(),
			model: model.trim(),
		};
		if (key.trim() !== "") body.key = key.trim();
		if (offer && addHost) body.addProxyHost = true;
		save.mutate(body, {
			onSuccess: () => {
				setKey("");
				setReplacing(false);
				toast.show({ tone: "success", title: "Provider saved" });
			},
		});
	}

	function onClear() {
		clear.mutate(
			{ clearKey: true },
			{
				onSuccess: () => {
					setReplacing(true);
					toast.show({ tone: "success", title: "Key cleared" });
				},
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: "Could not clear the key",
						children: errorText(error),
					}),
			},
		);
	}

	const modelOptions =
		listed && listed.length > 0
			? [...new Set([...(model ? [model] : []), ...listed])].map((m) => ({
					value: m,
					label: m,
				}))
			: null;

	return (
		<Group
			id="ai-provider-title"
			title="Provider"
			testId="ai-provider"
			description="The hosted model the assistant uses, and the key it signs in with."
		>
			<form className="grid max-w-[36rem] gap-4" noValidate onSubmit={onSubmit}>
				<Select
					id="ai-kind"
					label="Kind"
					options={KIND_OPTIONS}
					value={kind}
					onValueChange={onKind}
				/>
				<TextField
					id="ai-base-url"
					label="Base address"
					mono
					value={baseUrl}
					error={errors.baseUrl}
					hint="Filled in for the kind; change it for another OpenAI-compatible provider."
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => setBaseUrl(e.target.value)}
				/>
				{offer ? (
					<div className="grid gap-1" data-testid="ai-proxy-offer">
						<Checkbox
							label={
								<>
									Portikus will also allow the server to reach{" "}
									<code className="pk-mono-body [overflow-wrap:anywhere]">{offer}</code>{" "}
									on port 443
								</>
							}
							description="The server reaches outside hosts only through its proxy. Adding the host runs as a site change, so this page shows it as not allowed until that change finishes."
							checked={addHost}
							onChange={(e) => setAddHost(e.target.checked)}
						/>
					</div>
				) : null}
				{modelOptions ? (
					<Select
						id="ai-model"
						label="Model"
						options={modelOptions}
						value={model || undefined}
						placeholder="Choose a model"
						hint="The models the provider lists for this key."
						onValueChange={setModel}
					/>
				) : (
					<TextField
						id="ai-model"
						label="Model"
						mono
						value={model}
						error={errors.model}
						hint={
							configured
								? "The provider did not list its models; type the model's name."
								: "Type the model's name, such as the one in the provider's documentation."
						}
						autoComplete="off"
						spellCheck={false}
						onChange={(e) => setModel(e.target.value)}
					/>
				)}
				<fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
					<legend className="pk-label mb-1.5 p-0 text-[14px] font-medium">Key</legend>
					<div className="flex flex-wrap items-center gap-3">
						<span className="text-[14px]" data-testid="ai-key-state">
							{keyText(view)}
						</span>
						{view.keySet ? (
							<>
								{replacing ? null : (
									<Button
										size="sm"
										data-testid="ai-key-replace"
										onClick={() => setReplacing(true)}
									>
										Replace
									</Button>
								)}
								<Button
									size="sm"
									variant="danger-secondary"
									data-testid="ai-key-clear"
									loading={clear.isPending}
									onClick={onClear}
								>
									Clear
								</Button>
							</>
						) : null}
					</div>
					{replacing ? (
						<TextField
							id="ai-key"
							label={view.keySet ? "New key" : "Key"}
							type="password"
							mono
							value={key}
							autoComplete="off"
							spellCheck={false}
							hint="Saved with the provider. It is never shown again."
							onChange={(e) => setKey(e.target.value)}
						/>
					) : null}
				</fieldset>
				{save.isError ? (
					<p className="m-0 text-[13px] text-status-error" role="alert">
						{errorText(save.error)}
					</p>
				) : null}
				<div className="flex flex-wrap gap-2">
					<Button
						type="submit"
						variant="primary"
						data-testid="ai-provider-save"
						loading={save.isPending}
					>
						Save provider
					</Button>
				</div>
			</form>
		</Group>
	);
}
