import { Skeleton } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { AdminSection } from "../AdminSection.js";
import { useAiSettings } from "../ai/queries.js";
import { PriceTableGroup } from "./PriceTableGroup.js";
import { ProposalsGroup } from "./ProposalsGroup.js";
import { useAdminPricing } from "./queries.js";
import { RunGroup } from "./RunGroup.js";
import { SourcesGroup } from "./SourcesGroup.js";

const TITLE = "Model prices";

const INTRO = {
	id: "admin-pricing",
	helpAnchor: "admin-pricing",
	lead: "The API prices the student chat uses to say when a fresh chat would cost less.",
	text: "The assistant reads each provider's pricing page and proposes rows; you accept or reject each one. You can also add, edit and delete rows by hand.",
};

/** The model price table, its checks and their sources (SPEC.md sections 10.8 and 20.4). */
export function PricingTab() {
	const pricing = useAdminPricing();
	const ai = useAiSettings();
	if (pricing.isError) {
		return (
			<AdminSection title={TITLE} intro={INTRO}>
				<p className="m-0 text-status-error" role="alert">
					{errorText(pricing.error)}
				</p>
			</AdminSection>
		);
	}
	if (!pricing.data) {
		return (
			<AdminSection title={TITLE} intro={INTRO}>
				<div className="grid gap-6" aria-busy="true" data-testid="pricing-loading">
					<Skeleton variant="block" height={160} />
					<Skeleton variant="block" height={280} />
				</div>
			</AdminSection>
		);
	}
	const { prices, run, proposals } = pricing.data;
	return (
		<AdminSection title={TITLE} intro={INTRO}>
			<RunGroup run={run} ai={ai.data} />
			<ProposalsGroup proposals={proposals} />
			<PriceTableGroup prices={prices} />
			{ai.data ? (
				<SourcesGroup key={ai.data.priceSources.join(" ")} view={ai.data} />
			) : null}
		</AdminSection>
	);
}
