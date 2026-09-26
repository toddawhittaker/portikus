import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import * as React from "react";
import { Button, Icon, TextField } from "../primitives/index.js";
import { useReturnFocus } from "./dialog";

export const ConfirmDialogRoot = RadixAlertDialog.Root;
export const ConfirmDialogTrigger = RadixAlertDialog.Trigger;

export interface ConfirmDialogProps {
	id?: string;
	title: string;
	description?: React.ReactNode;
	lost?: React.ReactNode[];
	survives?: React.ReactNode[];
	confirmLabel: string;
	cancelLabel?: string;
	/** Exact text the person must type before the danger button enables. */
	confirmText?: string;
	onConfirm?: () => void;
	onCancel?: () => void;
	pending?: boolean;
	inline?: boolean;
	/** Test hook: set as `data-testid` on the dialog surface. */
	testId?: string;
	/** Preview only: start with this text already typed. */
	typedValue?: string;
	/** False for a reversible action: primary button, info icon, neutral colours. */
	destructive?: boolean;
}

/** The destructive confirmation. Render it inside a ConfirmDialogRoot. */
export function ConfirmDialog({
	id = "pk-confirm",
	title,
	description,
	lost,
	survives,
	confirmLabel,
	cancelLabel,
	confirmText,
	onConfirm,
	onCancel,
	pending,
	inline,
	testId,
	typedValue,
	destructive = true,
}: ConfirmDialogProps): React.ReactElement {
	const [typed, setTyped] = React.useState(typedValue ?? "");
	const ready = !confirmText || typed === confirmText;
	const returnFocus = useReturnFocus();
	return (
		<RadixAlertDialog.Portal>
			<RadixAlertDialog.Overlay
				className={`pk-scrim ${inline ? "pk-scrim--inline" : ""}`}
			/>
			<RadixAlertDialog.Content
				id={id}
				data-testid={testId}
				onOpenAutoFocus={returnFocus.onOpenAutoFocus}
				onCloseAutoFocus={returnFocus.onCloseAutoFocus}
				className={`pk-dialog ${inline ? "pk-dialog--inline" : ""}`}
			>
				<div className="flex items-start gap-3 px-6 pt-6">
					<div
						className={`pk-dialog-status ${destructive ? "" : "pk-dialog-status--neutral"}`}
					>
						<Icon name={destructive ? "alert" : "info"} size="lg" />
					</div>
					<div className="min-w-0">
						<RadixAlertDialog.Title className="m-0 text-xl font-semibold text-ink">
							{title}
						</RadixAlertDialog.Title>
						{description ? (
							<RadixAlertDialog.Description className="mt-1 mb-0 text-ink-muted">
								{description}
							</RadixAlertDialog.Description>
						) : null}
					</div>
				</div>
				{lost || survives || confirmText ? (
					<div className="px-6 pt-4">
						{lost || survives ? (
							<div className="pk-consequence">
								<div className="pk-lost rounded-md bg-surface-sunken p-3">
									<h3
										className={`mb-1 text-sm font-semibold ${destructive ? "text-status-danger" : "text-ink"}`}
									>
										Will be removed
									</h3>
									<ul className="m-0 list-disc pl-4 text-ink-muted">
										{(lost ?? []).map((item, index) => (
											// The list is static copy, so the index is a stable key.
											// biome-ignore lint/suspicious/noArrayIndexKey: static copy
											<li key={index}>{item}</li>
										))}
									</ul>
								</div>
								<div className="rounded-md bg-surface-sunken p-3">
									<h3 className="mb-1 text-sm font-semibold text-ink">Will be kept</h3>
									<ul className="m-0 list-disc pl-4 text-ink-muted">
										{(survives ?? []).map((item, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: static copy
											<li key={index}>{item}</li>
										))}
									</ul>
								</div>
							</div>
						) : null}
						{confirmText ? (
							<div className="mt-4">
								<TextField
									id={`${id}-typed`}
									label={
										<>
											Type <span className="font-mono">{confirmText}</span> to confirm
										</>
									}
									mono
									value={typed}
									onChange={(event) => setTyped(event.target.value)}
									autoComplete="off"
									spellCheck={false}
								/>
							</div>
						) : null}
					</div>
				) : null}
				<div className="flex justify-end gap-2 p-6">
					<RadixAlertDialog.Cancel asChild>
						<Button variant="secondary" onClick={onCancel}>
							{cancelLabel ?? "Cancel"}
						</Button>
					</RadixAlertDialog.Cancel>
					<Button
						data-testid="dialog-confirm"
						variant={destructive ? "danger" : "primary"}
						disabled={!ready}
						loading={pending}
						onClick={onConfirm}
					>
						{pending ? `${confirmLabel}…` : confirmLabel}
					</Button>
				</div>
			</RadixAlertDialog.Content>
		</RadixAlertDialog.Portal>
	);
}
