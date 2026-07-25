import { useState } from "react";
import { photoFileUrl, type Photo } from "../../api/journal";
import { Button } from "../../components/ui/Button";

export interface PhotoGridProps {
	photos: Photo[];
	onDelete: (photoId: string) => void;
	deleting?: boolean;
}

export function PhotoGrid({ photos, onDelete, deleting = false }: PhotoGridProps) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = photos.find((photo) => photo.id === selectedId) ?? null;

	if (photos.length === 0) {
		return <p className="activity-feed__empty">No photos yet.</p>;
	}

	return (
		<>
			<ul className="photo-grid">
				{photos.map((photo) => (
					<li key={photo.id}>
						<button
							type="button"
							className="photo-grid__thumb"
							onClick={() => setSelectedId(photo.id)}
						>
							<img src={photoFileUrl(photo.id)} alt={photo.caption ?? "Plant photo"} />
						</button>
					</li>
				))}
			</ul>

			{selected && (
				<div className="dialog" role="dialog" aria-modal="true" aria-label="Photo detail">
					<img
						src={photoFileUrl(selected.id)}
						alt={selected.caption ?? "Plant photo"}
						className="photo-grid__lightbox-image"
					/>
					{selected.caption && <p>{selected.caption}</p>}
					{selected.tags.length > 0 && (
						<p className="transition-history__meta">{selected.tags.join(", ")}</p>
					)}
					<div className="form-actions">
						<Button
							type="button"
							variant="ghost"
							disabled={deleting}
							onClick={() => {
								onDelete(selected.id);
								setSelectedId(null);
							}}
						>
							Delete
						</Button>
						<Button type="button" variant="ghost" onClick={() => setSelectedId(null)}>
							Close
						</Button>
					</div>
				</div>
			)}
		</>
	);
}
