import { Button, Icon } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { AdminGroup as Group } from "../AdminSection.js";
import { useTestAi } from "./queries.js";
import { type StageState, stageStates, TEST_STAGES, testErrorText } from "./text.js";

const STATE_TEXT: Record<StageState, string> = {
	done: "worked",
	failed: "failed",
	"not-reached": "not reached",
};

/**
 * One real round trip with a tool call, using the saved settings. Only the
 * stages reached show; the model's words never do (SPEC.md section 20.4).
 */
export function TestGroup() {
	const test = useTestAi();
	const result = test.data;
	const states = result ? stageStates(result.stage, result.ok) : null;
	return (
		<Group
			id="ai-test-title"
			title="Test"
			testId="ai-test"
			description="Asks the saved model to call one tool and use its answer. It sends no site data and uses a few hundred tokens."
			actions={
				<Button
					data-testid="ai-test-run"
					loading={test.isPending}
					onClick={() => test.mutate()}
				>
					Test
				</Button>
			}
		>
			<div role="status" className="grid gap-3" data-testid="ai-test-result">
				{result && states ? (
					<>
						<ol className="m-0 grid list-none gap-1.5 p-0 text-[14px]">
							{TEST_STAGES.map((s, i) => (
								<li
									key={s.stage}
									className="flex items-center gap-2"
									data-testid={`ai-test-stage-${s.stage}`}
									data-state={states[i]}
								>
									<StageMark state={states[i] ?? "not-reached"} />
									<span>
										{s.label}
										<span className="sr-only">
											: {STATE_TEXT[states[i] ?? "not-reached"]}
										</span>
									</span>
								</li>
							))}
						</ol>
						<p
							className={`m-0 text-[14px] ${result.ok ? "" : "text-status-error"}`}
							data-testid="ai-test-message"
						>
							{result.ok
								? `The test passed${result.model ? ` with ${result.model}` : ""}.`
								: testErrorText(result.errorCode ?? "")}
						</p>
					</>
				) : null}
				{test.isError ? (
					<p className="m-0 text-[13px] text-status-error">{errorText(test.error)}</p>
				) : null}
			</div>
		</Group>
	);
}

function StageMark({ state }: { state: StageState }) {
	if (state === "done")
		return <Icon name="check" size="sm" className="text-status-running" />;
	if (state === "failed")
		return <Icon name="alert" size="sm" className="text-status-error" />;
	return (
		<span
			aria-hidden={true}
			className="inline-block size-4 rounded-full border border-line-strong"
		/>
	);
}
