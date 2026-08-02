import { useState } from "react";
import type { PhotoUploadInput } from "../../api/journal";
import { Button } from "../../components/ui/Button";

export interface PhotoUploadComposerProps {
	onSubmit: (input: PhotoUploadInput) => void;
	onClose: () => void;
	submitting?: boolean;
	submitError?: string | null;
}

export function PhotoUploadComposer({
	onSubmit,
	onClose,
	submitting = false,
	submitError = null,
}: PhotoUploadComposerProps) {
	const [file, setFile] = useState<File | null>(null);
	const [caption, setCaption] = useState("");
	const [tags, setTags] = useState("");

	function submit() {
		if (!file) return;
		onSubmit({
			file,
			caption: caption.trim() || null,
			tags: tags
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
		});
	}

	return (
		<div className="dialog" role="dialog" aria-modal="true" aria-label="Add photo">
			<h2>Add photo</h2>

			<label className="field">
				<span>Photo</span>
				<input
					type="file"
					accept="image/jpeg,image/png,image/webp"
					onChange={(event) => setFile(event.target.files?.[0] ?? null)}
				/>
			</label>

			<label className="field">
				<span>Caption</span>
				<input value={caption} onChange={(event) => setCaption(event.target.value)} />
			</label>

			<label className="field">
				<span>Tags (comma separated)</span>
				<input value={tags} onChange={(event) => setTags(event.target.value)} />
			</label>

			{submitError && (
				<p className="form-error" role="alert">
					{submitError}
				</p>
			)}

			<div className="form-actions">
				<Button type="button" onClick={submit} disabled={submitting || !file}>
					Upload
				</Button>
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
