/**
 * The chat's images: where a local image loads from, and the dialog that
 * shows one large (SPEC.md §10.8, §24.1). Local images come through the
 * owner-only image route, which keeps them inside the student's home folder.
 */
import { Button, Dialog, DialogRoot } from "@portikus/ui";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { LayoutStoreContext } from "../layout/store.js";
import "./image-viewer.css";

export interface ViewerImage {
	src: string;
	/** The file name, shown as the dialog's title. */
	name: string;
	alt: string;
	/** Set when the image is a file inside the project, so it can open in a tab. */
	projectPath?: string;
}

interface ChatImages {
	/** The URL a local image path loads from. */
	imageUrl: (path: string) => string;
	open: (image: ViewerImage) => void;
}

const ChatImagesContext = createContext<ChatImages | null>(null);

/** The chat's images, or null outside a chat (a test, say), where none load. */
export function useChatImages(): ChatImages | null {
	return useContext(ChatImagesContext);
}

export function ImageViewerProvider({
	workspaceId,
	projectId,
	children,
}: {
	workspaceId: string;
	projectId: string;
	children: ReactNode;
}) {
	const [image, setImage] = useState<ViewerImage | null>(null);
	const imageUrl = useCallback(
		(path: string) =>
			`/workspaces/${workspaceId}/projects/${projectId}/image?path=${encodeURIComponent(path)}`,
		[workspaceId, projectId],
	);
	const value = useMemo(() => ({ imageUrl, open: setImage }), [imageUrl]);
	return (
		<ChatImagesContext.Provider value={value}>
			{children}
			<DialogRoot
				open={image !== null}
				onOpenChange={(open) => {
					if (!open) setImage(null);
				}}
			>
				{image ? <ImageViewer image={image} onClose={() => setImage(null)} /> : null}
			</DialogRoot>
		</ChatImagesContext.Provider>
	);
}

function ImageViewer({ image, onClose }: { image: ViewerImage; onClose: () => void }) {
	const layout = useContext(LayoutStoreContext);
	const { projectPath } = image;
	return (
		<Dialog
			title={image.name}
			size="lg"
			className="pk-image-viewer"
			testId="chat-image-viewer"
			footer={
				<>
					{projectPath && layout ? (
						<Button
							onClick={() => {
								onClose();
								layout.getState().openFile(projectPath);
							}}
						>
							Open in editor
						</Button>
					) : null}
					<Button variant="primary" onClick={onClose}>
						Close
					</Button>
				</>
			}
		>
			<img className="pk-image-viewer-img" src={image.src} alt={image.alt} />
		</Dialog>
	);
}
