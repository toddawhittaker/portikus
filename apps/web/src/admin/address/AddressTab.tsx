import { AdminSection } from "../AdminSection.js";

const INTRO = {
	id: "admin-address",
	helpAnchor: "admin-address",
	text: "Move the site to a new host name or port. The move is a trial: open the new address and press Keep there, or the old address comes back by itself after 15 minutes.",
};

/** The Site address tab of the admin page: plan, pre-flight and trial (ADR 0059). */
export function AddressTab() {
	return (
		<AdminSection title="Site address" intro={INTRO}>
			{null}
		</AdminSection>
	);
}
