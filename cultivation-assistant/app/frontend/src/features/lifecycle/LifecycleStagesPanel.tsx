import {
	useCreateLifecycleStage,
	useDeleteLifecycleStage,
	useLifecycleStages,
	useReorderLifecycleStages,
	useUpdateLifecycleStage,
} from "../../api/lifecycle";
import { LoadingState } from "../../components/ui/StatePanel";
import { LifecycleStageSettings } from "./LifecycleStageSettings";

export function LifecycleStagesPanel() {
	const stages = useLifecycleStages(true);
	const reorder = useReorderLifecycleStages();
	const updateStage = useUpdateLifecycleStage();
	const createStage = useCreateLifecycleStage();
	const deleteStage = useDeleteLifecycleStage();

	if (stages.isLoading) return <LoadingState label="Loading lifecycle stages" />;
	if (stages.isError || !stages.data) {
		return <p role="alert">Lifecycle stages could not be loaded.</p>;
	}

	return (
		<LifecycleStageSettings
			stages={stages.data}
			onReorder={(ids) => reorder.mutate(ids)}
			onRename={(stageId, label) =>
				updateStage.mutate({ stageId, input: { label } })
			}
			onToggle={(stageId, enabled) =>
				updateStage.mutate({ stageId, input: { enabled } })
			}
			onCreate={(input) => createStage.mutate(input)}
			onDelete={(stageId) => deleteStage.mutate(stageId)}
		/>
	);
}
