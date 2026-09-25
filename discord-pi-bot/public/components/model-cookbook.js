async function readModelResponse(response) {
	if (response.status === 204) return {};
	let body;
	try {
		body = await response.json();
	} catch (_) {
		body = {};
	}
	if (!response.ok) {
		throw new Error(body.message || "Model operation failed.");
	}
	return body;
}

window.RemindMeModelCookbook = {
	state() {
		return {
			modelManagerEnabled: true,
			modelPairingConfigured: false,
			pairingCode: "",
			pairingBusy: false,
			modelCatalog: [],
			modelHardware: null,
			modelInventory: [],
			modelInventoryWarnings: [],
			modelInventoryLoading: false,
			modelInventoryError: "",
			modelStatus: null,
			modelOperation: null,
			modelError: "",
			modelYaml: "",
			modelYamlId: "",
			modelYamlMessage: "",
			hfToken: "",
			customModel: { repo: "", file: "" },
			modelEvents: null,
			/* Set while a "download & use" waits for its download to finish
			 * before the console starts chatting with it. */
			pendingChatId: "",
		};
	},

	async load(vm) {
		vm.modelError = "";
		try {
			const pairing = await fetch("./api/models/pairing").then(
				readModelResponse,
			);
			vm.modelPairingConfigured = pairing.configured === true;
			if (!vm.modelPairingConfigured) return;
			await Promise.all([
				this.loadCatalog(vm),
				this.loadStatus(vm),
				this.loadInventory(vm),
			]);
			this.connect(vm);
		} catch (error) {
			vm.modelError = error.message || "Model cookbook is unavailable.";
		}
	},

	async pair(vm) {
		const code = vm.pairingCode.trim().toUpperCase();
		if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
			vm.modelError =
				"Enter the six-character code shown by the llama.cpp add-on.";
			return;
		}
		vm.pairingBusy = true;
		vm.modelError = "";
		try {
			const result = await fetch("./api/models/pair", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code }),
			}).then(readModelResponse);
			vm.modelPairingConfigured = result.configured === true;
			if (vm.modelPairingConfigured) await this.load(vm);
		} catch (error) {
			vm.modelError = error.message || "Model manager pairing failed.";
		} finally {
			vm.pairingCode = "";
			vm.pairingBusy = false;
		}
	},

	async loadCatalog(vm) {
		const catalog = await fetch("./api/models").then(readModelResponse);
		vm.modelCatalog = Array.isArray(catalog.variants) ? catalog.variants : [];
		vm.modelHardware = catalog.hardware || null;
	},

	async loadStatus(vm) {
		const status = await fetch("./api/models/status").then(readModelResponse);
		vm.modelStatus = status;
		vm.modelOperation = status.operation || vm.modelOperation;
	},

	async loadInventory(vm) {
		vm.modelInventoryLoading = true;
		vm.modelInventoryError = "";
		try {
			const result = await fetch("./api/models/inventory").then(
				readModelResponse,
			);
			vm.modelInventory = Array.isArray(result.items) ? result.items : [];
			vm.modelInventoryWarnings = Array.isArray(result.warnings)
				? result.warnings
				: [];
		} catch (error) {
			vm.modelInventoryError =
				error.message || "Downloaded models could not be scanned.";
		} finally {
			vm.modelInventoryLoading = false;
		}
	},

	connect(vm) {
		if (typeof EventSource === "undefined") return;
		vm.modelEvents?.close();
		const source = new EventSource("./api/models/events");
		source.addEventListener("operation", (event) => {
			try {
				vm.modelOperation = JSON.parse(event.data);
			} catch (_) {
				vm.modelError = "Model progress returned malformed data.";
				return;
			}
			const phase = vm.modelOperation.phase;
			if (["idle", "active", "failed", "degraded"].includes(phase)) {
				this.loadStatus(vm).catch(() => {});
				this.loadCatalog(vm).catch(() => {});
				this.loadInventory(vm).catch(() => {});
			}
			// A "download & use" whose download just finished becomes the chat model.
			if (phase === "idle" && vm.pendingChatId) {
				const target = vm.pendingChatId;
				vm.pendingChatId = "";
				void this.setChat(vm, target);
			}
			// A failed download must not then be chosen.
			if (["failed", "degraded"].includes(phase)) vm.pendingChatId = "";
			// A completed switch: refresh the header badge to the new model.
			if (phase === "active") vm.refreshStatus?.();
		});
		source.onerror = () => {
			vm.modelError =
				"Model progress connection interrupted; server recovery remains active.";
		};
		vm.modelEvents = source;
	},

	async mutate(vm, path, method, body) {
		vm.modelError = "";
		try {
			const response = await fetch(path, {
				method,
				headers:
					body === undefined
						? undefined
						: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const result = await readModelResponse(response);
			if (result.operation) vm.modelOperation = result.operation;
			await this.loadCatalog(vm);
			return result;
		} catch (error) {
			vm.modelError = error.message || "Model operation failed.";
			return null;
		}
	},

	download(vm, id) {
		return this.mutate(vm, "./api/models/install", "POST", { id });
	},

	/*
	 * Make a model the add-on's default: what every request that names no
	 * model gets, including other apps. The add-on serves all downloaded
	 * models at once, so this is a switch of pointer, not a restart.
	 */
	activate(vm, id) {
		return this.mutate(vm, "./api/models/activate", "POST", { id });
	},

	/*
	 * Chat with a model. Only the console's own requests change; the add-on's
	 * default, and so every other app, is untouched. Right after a download the
	 * add-on takes a moment to start serving the new file, so a "not served"
	 * answer is retried briefly.
	 */
	async setChat(vm, id) {
		vm.modelError = "";
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const response = await fetch("./api/models/chat", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id }),
			});
			if (response.status !== 409 || attempt === 9) {
				try {
					await readModelResponse(response);
				} catch (error) {
					vm.modelError = error.message || "Choosing the chat model failed.";
					return null;
				}
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		await this.loadStatus(vm);
		vm.refreshStatus?.();
		return { chatModel: id };
	},

	/*
	 * One click to "use" a model: chat with it if it is downloaded, otherwise
	 * download and verify first, then choose it when the download completes
	 * (see the pendingChatId handling in connect()).
	 */
	async use(vm, id) {
		const variant = vm.modelCatalog.find((item) => item.model.id === id);
		if (vm.modelStatus?.chatModel === id) return null;
		if (variant?.verified) return this.setChat(vm, id);
		vm.pendingChatId = id;
		const result = await this.download(vm, id);
		if (result?.alreadyInstalled) {
			vm.pendingChatId = "";
			return this.setChat(vm, id);
		}
		return result;
	},

	async loadYaml(vm, id) {
		const response = await fetch(
			`./api/models/${encodeURIComponent(id)}/options.yaml`,
		);
		const body = await response.text();
		if (!response.ok) {
			let message = "Model configuration is unavailable.";
			try {
				message = JSON.parse(body).message || message;
			} catch {
				message = "Model configuration is unavailable.";
			}
			throw new Error(message);
		}
		vm.modelYaml = body;
		vm.modelYamlId = id;
		return body;
	},

	async copyYaml(vm, id) {
		vm.modelError = "";
		try {
			const yaml = await this.loadYaml(vm, id);
			if (!navigator.clipboard?.writeText)
				throw new Error(
					"Clipboard access was denied. Use Download YAML instead.",
				);
			await navigator.clipboard.writeText(yaml);
			vm.modelYamlMessage =
				"Copied. Paste into the llama.cpp add-on Configuration, save, and restart the llama.cpp add-on.";
		} catch (error) {
			vm.modelError =
				error.message ||
				"Clipboard access was denied. Use Download YAML instead.";
		}
	},

	async downloadYaml(vm, id) {
		vm.modelError = "";
		try {
			const yaml =
				vm.modelYamlId === id ? vm.modelYaml : await this.loadYaml(vm, id);
			const blob = new Blob([yaml], { type: "text/yaml;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${id}-options.yaml`;
			anchor.click();
			URL.revokeObjectURL(url);
			vm.modelYamlMessage =
				"Downloaded YAML. Paste it into the llama.cpp add-on Configuration, save, and restart the llama.cpp add-on.";
		} catch (error) {
			vm.modelError = error.message || "Model configuration download failed.";
		}
	},

	cancel(vm) {
		return this.mutate(vm, "./api/models/cancel", "POST", {});
	},

	remove(vm, id) {
		return this.mutate(vm, `./api/models/${encodeURIComponent(id)}`, "DELETE");
	},

	async removeInventoryItem(vm, item) {
		if (!item?.removable) return;
		const size = this.formatBytes(item.size);
		if (!window.confirm(`Remove "${item.name}" and reclaim ${size}?`)) return;
		vm.modelInventoryError = "";
		try {
			const response = await fetch(
				`./api/models/inventory/${encodeURIComponent(item.id)}`,
				{ method: "DELETE" },
			);
			await readModelResponse(response);
			await Promise.all([this.loadInventory(vm), this.loadCatalog(vm)]);
		} catch (error) {
			vm.modelInventoryError =
				error.message || "Downloaded model could not be removed.";
		}
	},

	async saveToken(vm) {
		const token = vm.hfToken.trim();
		if (!token) {
			vm.modelError = "Enter a Hugging Face access token.";
			return;
		}
		try {
			await this.mutate(vm, "./api/models/credentials", "PUT", { token });
			await this.loadStatus(vm);
		} finally {
			vm.hfToken = "";
		}
	},

	async saveCustom(vm) {
		const repo = vm.customModel.repo.trim();
		const file = vm.customModel.file.trim();
		const result = await this.mutate(vm, "./api/models/custom", "POST", {
			repo,
			file,
		});
		if (result) vm.customModel = { repo: "", file: "" };
	},

	formatBytes(bytes) {
		const value = Number(bytes || 0);
		if (!value) return "Unknown";
		if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
		return `${Math.ceil(value / 1024 ** 2)} MB`;
	},

	progressPercent(operation) {
		if (!operation?.bytesTotal) return 0;
		return Math.min(100, (operation.bytesDone / operation.bytesTotal) * 100);
	},
};
