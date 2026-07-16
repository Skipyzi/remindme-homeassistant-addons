package hardware

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"

	"remindme.local/model-manager/internal/catalog"
)

const (
	CodeInsufficientMemory  = "insufficient_memory"
	CodeInsufficientStorage = "insufficient_storage"
)

type Facts struct {
	TotalRAM           int64  `json:"totalRAM"`
	FreeRAM            int64  `json:"freeRAM"`
	FreeDisk           int64  `json:"freeDisk"`
	RetainedModelBytes int64  `json:"retainedModelBytes"`
	CPUCores           int    `json:"cpuCores"`
	Architecture       string `json:"architecture"`
}

type Runtime struct {
	Context         int    `json:"context"`
	Batch           int    `json:"batch"`
	UBatch          int    `json:"ubatch"`
	Threads         int    `json:"threads"`
	ReasoningFormat string `json:"reasoningFormat"`
	ReasoningMode   string `json:"reasoningMode"`
}

type Assessment struct {
	Safe         bool     `json:"safe"`
	OverrideUsed bool     `json:"overrideUsed"`
	Code         string   `json:"code,omitempty"`
	RequiredRAM  int64    `json:"requiredRAM"`
	RequiredDisk int64    `json:"requiredDisk"`
	Runtime      Runtime  `json:"runtime"`
	Warnings     []string `json:"warnings"`
	Score        int      `json:"score"`
}

func EstimateKV(parameters int64, context int) int64 {
	bytesPerToken := int64(128 * 1024)
	if parameters >= 3_000_000_000 {
		bytesPerToken = 256 * 1024
	}
	return int64(max(context, 0)) * bytesPerToken
}

func Assess(variant catalog.Variant, facts Facts, requestedContext int, override bool) Assessment {
	contextLimit := variant.RecommendedContext
	if contextLimit <= 0 {
		contextLimit = 4096
	}
	context := min(max(requestedContext, 1024), contextLimit)
	kv := EstimateKV(variant.Parameters, context)
	overhead := max(int64(512*1024*1024), variant.ExpectedBytes/5)
	working := variant.ExpectedBytes + kv + overhead
	requiredRAM := working + working/4
	requiredDisk := variant.ExpectedBytes*2 + facts.RetainedModelBytes + 512*1024*1024

	profile := variant.Runtime
	result := Assessment{
		Safe:         true,
		RequiredRAM:  requiredRAM,
		RequiredDisk: requiredDisk,
		Runtime: Runtime{
			Context:         context,
			Batch:           min(max(profile.Batch, 1), 256),
			UBatch:          min(max(profile.UBatch, 1), 128),
			Threads:         min(max(facts.CPUCores, 1), max(profile.Threads, 1)),
			ReasoningFormat: profile.ReasoningFormat,
			ReasoningMode:   profile.ReasoningMode,
		},
	}

	if requiredRAM > facts.TotalRAM {
		result.Code = CodeInsufficientMemory
		result.Safe = override
		result.OverrideUsed = override
		result.Warnings = append(result.Warnings, "Estimated model memory exceeds the safe hardware budget.")
	} else if facts.FreeRAM > 0 && requiredRAM > facts.FreeRAM+variant.ExpectedBytes {
		result.Warnings = append(result.Warnings, "Close other workloads before activating this model.")
	}
	if requiredDisk > facts.FreeDisk {
		result.Code = CodeInsufficientStorage
		result.Safe = false
		result.OverrideUsed = false
		result.Warnings = append(result.Warnings, "Storage must cover the candidate, temporary file, and rollback models.")
	}

	result.Score = compatibilityScore(variant, facts, result)
	return result
}

func compatibilityScore(variant catalog.Variant, facts Facts, assessment Assessment) int {
	if !assessment.Safe {
		return 0
	}
	score := 60
	if variant.RecommendedRAM <= facts.TotalRAM {
		score += 20
	}
	if variant.Tier == catalog.TierRecommended {
		score += 15
	}
	if variant.ExpectedBytes < 2*1024*1024*1024 {
		score += 5
	}
	return min(score, 100)
}

func ReadFacts(modelDir string) (Facts, error) {
	total, available, err := readLinuxMemory("/proc/meminfo")
	if err != nil {
		return Facts{}, err
	}
	freeDisk, err := diskFree(modelDir)
	if err != nil {
		return Facts{}, err
	}
	return Facts{
		TotalRAM: total, FreeRAM: available, FreeDisk: freeDisk,
		CPUCores: runtime.NumCPU(), Architecture: runtime.GOARCH,
	}, nil
}

func readLinuxMemory(path string) (int64, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()
	var total, available int64
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, parseErr := strconv.ParseInt(fields[1], 10, 64)
		if parseErr != nil {
			return 0, 0, fmt.Errorf("parse memory facts: %w", parseErr)
		}
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			total = value * 1024
		case "MemAvailable":
			available = value * 1024
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if total <= 0 || available <= 0 {
		return 0, 0, errors.New("memory facts are unavailable")
	}
	return total, available, nil
}
