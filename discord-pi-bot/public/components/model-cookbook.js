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
			modelStatus: null,
			modelOperation: null,
			modelError: "",
			hfToken: "",
			customModel: { repo: "", file: "" },
			modelEvents: null,
		};
	},

	async load(vm) {
		vm.modelError = "";
		try {
			const pairing = await fetch("./api/models/pairing").then(readModelResponse);
			vm.modelPairingConfigured = pairing.configured === true;
			if (!vm.modelPairingConfigured) return;
			await Promise.all([this.loadCatalog(vm), this.loadStatus(vm)]);
			this.connect(vm);
		} catch (error) {
			vm.modelError = error.message || "Model cookbook is unavailable.";
		}
	},

	async pair(vm) {
		const code = vm.pairingCode.trim().toUpperCase();
		if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
			vm.modelError = "Enter the six-character code shown by the llama.cpp add-on.";
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
			if (["active", "failed", "degraded"].includes(vm.modelOperation.phase)) {
				this.loadStatus(vm).catch(() => {});
				this.loadCatalog(vm).catch(() => {});
			}
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

	install(vm, id) {
		return this.mutate(vm, "./api/models/install", "POST", { id });
	},

	activate(vm, id) {
		return this.mutate(vm, "./api/models/activate", "POST", { id });
	},

	cancel(vm) {
		return this.mutate(vm, "./api/models/cancel", "POST", {});
	},

	remove(vm, id) {
		return this.mutate(vm, `./api/models/${encodeURIComponent(id)}`, "DELETE");
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
