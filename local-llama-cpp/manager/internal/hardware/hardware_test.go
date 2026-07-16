package hardware

import (
	"testing"

	"remindme.local/model-manager/internal/catalog"
)

func qwen4Variant() catalog.Variant {
	return catalog.Variant{
		ExpectedBytes:      2497280256,
		Parameters:         4022468096,
		RecommendedContext: 8192,
		MinimumRAM:         6442450944,
		RecommendedRAM:     7516192768,
		Runtime: catalog.RuntimeProfile{
			Batch: 256, UBatch: 128, Threads: 4,
			ReasoningFormat: "deepseek", ReasoningMode: "auto",
		},
	}
}

func TestAssessQwen4BFitsPi8GBAtBoundedContext(t *testing.T) {
	assessment := Assess(qwen4Variant(), Facts{
		TotalRAM: 8589934592, FreeRAM: 7516192768, FreeDisk: 12884901888,
		CPUCores: 4, Architecture: "arm64",
	}, 8192, false)
	if !assessment.Safe || assessment.Runtime.Context != 8192 || assessment.Runtime.Threads != 4 {
		t.Fatalf("unexpected assessment: %#v", assessment)
	}
}

func TestAssessRejectsUnsafeMemoryWithoutOverride(t *testing.T) {
	assessment := Assess(qwen4Variant(), Facts{
		TotalRAM: 4294967296, FreeRAM: 3221225472, FreeDisk: 12884901888,
		CPUCores: 4, Architecture: "arm64",
	}, 8192, false)
	if assessment.Safe || assessment.Code != CodeInsufficientMemory {
		t.Fatalf("unexpected assessment: %#v", assessment)
	}
}

func TestAssessAllowsExplicitMemoryOverrideButNotDiskOverride(t *testing.T) {
	facts := Facts{TotalRAM: 4294967296, FreeRAM: 3221225472, FreeDisk: 12884901888, CPUCores: 4, Architecture: "arm64"}
	if assessment := Assess(qwen4Variant(), facts, 8192, true); !assessment.Safe || assessment.Code != CodeInsufficientMemory {
		t.Fatalf("memory override failed: %#v", assessment)
	}
	facts.FreeDisk = 100
	if assessment := Assess(qwen4Variant(), facts, 8192, true); assessment.Safe || assessment.Code != CodeInsufficientStorage {
		t.Fatalf("disk safety bypassed: %#v", assessment)
	}
}

func TestRuntimeIsClampedToHardwareAndCatalog(t *testing.T) {
	variant := qwen4Variant()
	variant.Runtime.Threads = 16
	variant.Runtime.Batch = 1024
	variant.Runtime.UBatch = 512
	assessment := Assess(variant, Facts{
		TotalRAM: 8589934592, FreeRAM: 8589934592, FreeDisk: 12884901888,
		CPUCores: 2, Architecture: "arm64",
	}, 50000, false)
	if assessment.Runtime.Threads != 2 || assessment.Runtime.Batch != 256 || assessment.Runtime.UBatch != 128 || assessment.Runtime.Context != 8192 {
		t.Fatalf("runtime not clamped: %#v", assessment.Runtime)
	}
}

func TestEstimateKVScalesWithContextAndModelClass(t *testing.T) {
	small := EstimateKV(1_000_000_000, 4096)
	large := EstimateKV(4_000_000_000, 4096)
	if small <= 0 || large != small*2 {
		t.Fatalf("unexpected estimates small=%d large=%d", small, large)
	}
}
