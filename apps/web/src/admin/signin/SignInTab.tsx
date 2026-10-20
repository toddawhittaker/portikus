import { AdminSection } from "../AdminSection.js";
import { CoursesGroup } from "./CoursesGroup.js";
import { LmsGroup } from "./LmsGroup.js";
import { SsoGroup } from "./SsoGroup.js";

const INTRO = {
	id: "admin-signin",
	helpAnchor: "admin-signin",
	text: "Choose how people sign in, and register the learning management systems that launch Portikus, and choose the interface each course's students see. A sign-in change is a trial: test it, then keep it, or it is put back by itself after 30 minutes.",
};

/** The Sign-in tab of the admin page: single sign-on, then LMS platforms (SPEC.md section 20.1). */
export function SignInTab() {
	return (
		<AdminSection title="Sign-in" intro={INTRO}>
			<SsoGroup />
			<LmsGroup />
			<CoursesGroup />
		</AdminSection>
	);
}
