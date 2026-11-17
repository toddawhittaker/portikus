import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { LmsGroup } from "./LmsGroup.js";

afterEach(() => vi.unstubAllGlobals());

const PAGE = {
	toolUrls: {
		loginUrl: "https://portikus.example.edu/lti/login",
		launchUrl: "https://portikus.example.edu/lti/launch",
		keysetUrl: "https://portikus.example.edu/lti/jwks",
		deepLinkingUrl: "https://portikus.example.edu/lti/deep-link",
	},
	operatorPlatforms: [],
	platforms: [],
	job: null,
};

test("Add platform opens the platform dialog when no change is running", async () => {
	stubFetch(() => json(200, PAGE));
	renderWithQuery(<LmsGroup />);
	fireEvent.click(await screen.findByTestId("lms-add"));
	expect(await screen.findByTestId("lms-save")).toBeTruthy();
});
