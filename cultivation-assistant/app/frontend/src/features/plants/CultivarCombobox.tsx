import { useId, useMemo, useState } from "react";
import type { Cultivar, CultivarCreateInput, SeedType } from "../../api/library";
import { Button } from "../../components/ui/Button";

const SEED_TYPES: SeedType[] = ["unknown", "regular", "feminized", "autoflower"];

export interface CultivarComboboxProps {
	cultivars: Cultivar[];
	value: string;
	onChange: (cultivarId: string) => void;
	onCreateCultivar: (input: CultivarCreateInput) => Promise<Cultivar>;
}

export function CultivarCombobox({
	cultivars,
	value,
	onChange,
	onCreateCultivar,
}: CultivarComboboxProps) {
	const listId = useId();
	const [search, setSearch] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newSeedType, setNewSeedType] = useState<SeedType>("unknown");
	const [error, setError] = useState<string | null>(null);

	const selected = cultivars.find((cultivar) => cultivar.id === value) ?? null;

	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		if (!query) return cultivars;
		return cultivars.filter((cultivar) =>
			cultivar.name.toLowerCase().includes(query),
		);
	}, [cultivars, search]);

	async function saveCultivar() {
		if (!newName.trim()) {
			setError("A cultivar name is required.");
			return;
		}
		try {
			const created = await onCreateCultivar({
				name: newName.trim(),
				breeder_id: null,
				seed_type: newSeedType,
			});
			onChange(created.id);
			setCreating(false);
			setNewName("");
			setError(null);
		} catch {
			setError("The cultivar could not be created.");
		}
	}

	return (
		<div className="combobox">
			<label className="field">
				<span id={`${listId}-label`}>Cultivar</span>
				<input
					type="text"
					role="combobox"
					aria-expanded={expanded}
					aria-controls={listId}
					aria-labelledby={`${listId}-label`}
					value={search || selected?.name || ""}
					onFocus={() => setExpanded(true)}
					onChange={(event) => {
						setSearch(event.target.value);
						setExpanded(true);
					}}
					placeholder="Search cultivars"
				/>
			</label>

			{expanded && (
				<ul id={listId} role="listbox" className="combobox__list">
					{filtered.length === 0 && (
						<li className="combobox__empty">No matching cultivars</li>
					)}
					{filtered.map((cultivar) => (
						<li key={cultivar.id} role="option" aria-selected={cultivar.id === value}>
							<button
								type="button"
								onClick={() => {
									onChange(cultivar.id);
									setSearch("");
									setExpanded(false);
								}}
							>
								{cultivar.name}
								{cultivar.breeder ? ` · ${cultivar.breeder.name}` : ""}
							</button>
						</li>
					))}
				</ul>
			)}

			{!creating ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setCreating(true)}
				>
					Add cultivar
				</Button>
			) : (
				<div className="combobox__create">
					<label className="field">
						<span>Cultivar name</span>
						<input
							value={newName}
							onChange={(event) => setNewName(event.target.value)}
						/>
					</label>
					<label className="field">
						<span>Seed type</span>
						<select
							value={newSeedType}
							onChange={(event) =>
								setNewSeedType(event.target.value as SeedType)
							}
						>
							{SEED_TYPES.map((type) => (
								<option key={type} value={type}>
									{type}
								</option>
							))}
						</select>
					</label>
					{error && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					<div className="form-actions">
						<Button type="button" size="sm" onClick={saveCultivar}>
							Save cultivar
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => setCreating(false)}
						>
							Cancel
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
