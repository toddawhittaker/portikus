import {
	AiSettingsView,
	ModelListResponse,
	TestAiResult,
	type UpdateAiSettingsRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../../api/request.js";

const aiKey = ["admin", "ai"] as const;

export function useAiSettings() {
	return useQuery({
		queryKey: aiKey,
		queryFn: () => request(AiSettingsView, "/admin/ai"),
		retry: false,
	});
}

/** The provider's model names; asked only once a provider and key are saved. */
export function useAiModels(enabled: boolean, savedFor: string) {
	return useQuery({
		queryKey: [...aiKey, "models", savedFor],
		queryFn: () => request(ModelListResponse, "/admin/ai/models"),
		enabled,
		retry: false,
		staleTime: 5 * 60_000,
	});
}

function useSetView() {
	const client = useQueryClient();
	return (view: AiSettingsView) => client.setQueryData(aiKey, view);
}

export function useUpdateAi() {
	const setView = useSetView();
	return useMutation({
		mutationFn: (body: UpdateAiSettingsRequest) =>
			sendJson(AiSettingsView, "/admin/ai", body, "PUT"),
		onSuccess: setView,
	});
}

export function useAcceptNotice() {
	const setView = useSetView();
	return useMutation({
		mutationFn: (noticeVersion: number) =>
			sendJson(AiSettingsView, "/admin/ai/notice", { noticeVersion }),
		onSuccess: setView,
	});
}

export function useTestAi() {
	return useMutation({
		mutationFn: () => sendJson(TestAiResult, "/admin/ai/test", {}),
	});
}
