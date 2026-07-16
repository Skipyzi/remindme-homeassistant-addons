package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

type Capability string

type Tier string

const (
	CapabilityChat      Capability = "chat"
	CapabilityTools     Capability = "tools"
	CapabilityReasoning Capability = "reasoning"
	CapabilityVision    Capability = "vision"
)

const (
	TierRecommended  Tier = "recommended"
	TierCompatible   Tier = "compatible"
	TierExperimental Tier = "experimental"
)

type RuntimeProfile struct {
	Batch           int    `json:"batch"`
	UBatch          int    `json:"ubatch"`
	Threads         int    `json:"threads"`
	ReasoningFormat string `json:"reasoningFormat"`
	ReasoningMode   string `json:"reasoningMode"`
}

type Variant struct {
	ID                 string         `json:"id"`
	Family             string         `json:"family"`
	Repo               string         `json:"repo"`
	File               string         `json:"file"`
	Parameters         int64          `json:"parameters"`
	Quantization       string         `json:"quantization"`
	ExpectedBytes      int64          `json:"expectedBytes"`
	SHA256             string         `json:"sha256,omitempty"`
	MinimumRAM         int64          `json:"minimumRAM"`
	RecommendedRAM     int64          `json:"recommendedRAM"`
	NativeContext      int            `json:"nativeContext"`
	RecommendedContext int            `json:"recommendedContext"`
	Capabilities       []Capability   `json:"capabilities"`
	Tier               Tier           `json:"tier"`
	Source             string         `json:"source"`
	Gated              bool           `json:"gated,omitempty"`
	Runtime            RuntimeProfile `json:"runtime"`
	Unverified         bool           `json:"unverified,omitempty"`
	LocalPath          string         `json:"-"`
}

type PublicVariant struct {
	ID                 string         `json:"id"`
	Family             string         `json:"family"`
	Repo               string         `json:"repo"`
	File               string         `json:"file"`
	Parameters         int64          `json:"parameters"`
	Quantization       string         `json:"quantization"`
	ExpectedBytes      int64          `json:"expectedBytes"`
	MinimumRAM         int64          `json:"minimumRAM"`
	RecommendedRAM     int64          `json:"recommendedRAM"`
	NativeContext      int            `json:"nativeContext"`
	RecommendedContext int            `json:"recommendedContext"`
	Capabilities       []Capability   `json:"capabilities"`
	Tier               Tier           `json:"tier"`
	Source             string         `json:"source"`
	Gated              bool           `json:"gated"`
	Runtime            RuntimeProfile `json:"runtime"`
	Unverified         bool           `json:"unverified"`
}

type Catalog struct {
	Variants []Variant `json:"variants"`
}

type CustomInput struct {
	Repo string `json:"repo"`
	File string `json:"file"`
}

var repoPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$`)
var filePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$`)
var checksumPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var idCleaner = regexp.MustCompile(`[^a-z0-9-]+`)

func Load(reader io.Reader) (Catalog, error) {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var result Catalog
	if err := decoder.Decode(&result); err != nil {
		return Catalog{}, fmt.Errorf("decode catalog: %w", err)
	}
	if len(result.Variants) == 0 {
		return Catalog{}, errors.New("catalog must contain at least one variant")
	}
	seen := make(map[string]struct{}, len(result.Variants))
	for _, variant := range result.Variants {
		if _, exists := seen[variant.ID]; exists {
			return Catalog{}, fmt.Errorf("duplicate catalog id %q", variant.ID)
		}
		seen[variant.ID] = struct{}{}
		if err := validateCurated(variant); err != nil {
			return Catalog{}, fmt.Errorf("variant %q: %w", variant.ID, err)
		}
	}
	return result, nil
}

func validateCurated(variant Variant) error {
	if variant.ID == "" || variant.Family == "" || !repoPattern.MatchString(variant.Repo) || !filePattern.MatchString(variant.File) {
		return errors.New("invalid identity, repository, or GGUF filename")
	}
	if variant.Parameters <= 0 || variant.ExpectedBytes <= 0 || variant.MinimumRAM <= 0 || variant.RecommendedRAM <= 0 {
		return errors.New("model and memory sizes must be positive")
	}
	if variant.NativeContext <= 0 || variant.RecommendedContext <= 0 || variant.RecommendedContext > variant.NativeContext {
		return errors.New("invalid context limits")
	}
	if !checksumPattern.MatchString(variant.SHA256) {
		return errors.New("curated variants require a lowercase SHA-256 checksum")
	}
	if len(variant.Capabilities) == 0 || variant.Runtime.Threads <= 0 || variant.Runtime.Batch <= 0 || variant.Runtime.UBatch <= 0 {
		return errors.New("capabilities and runtime limits are required")
	}
	return nil
}

func ValidateCustom(input CustomInput) (Variant, error) {
	if !repoPattern.MatchString(input.Repo) || !filePattern.MatchString(input.File) {
		return Variant{}, errors.New("repository and file must identify one Hugging Face GGUF")
	}
	rawID := strings.ToLower(strings.NewReplacer("/", "-", ".", "-").Replace(input.Repo + "-" + input.File))
	id := "custom-" + strings.Trim(idCleaner.ReplaceAllString(rawID, "-"), "-")
	return Variant{
		ID:                 id,
		Family:             input.Repo,
		Repo:               input.Repo,
		File:               input.File,
		Quantization:       "unknown",
		RecommendedContext: 4096,
		NativeContext:      4096,
		Capabilities:       []Capability{CapabilityChat},
		Tier:               TierExperimental,
		Source:             "custom",
		Unverified:         true,
		Runtime: RuntimeProfile{
			Batch:         128,
			UBatch:        64,
			Threads:       4,
			ReasoningMode: "off",
		},
	}, nil
}

func (catalog Catalog) Find(id string) (Variant, bool) {
	for _, variant := range catalog.Variants {
		if variant.ID == id {
			return variant, true
		}
	}
	return Variant{}, false
}

func (variant Variant) Public() PublicVariant {
	capabilities := append([]Capability(nil), variant.Capabilities...)
	return PublicVariant{
		ID: variant.ID, Family: variant.Family, Repo: variant.Repo, File: variant.File,
		Parameters: variant.Parameters, Quantization: variant.Quantization,
		ExpectedBytes: variant.ExpectedBytes, MinimumRAM: variant.MinimumRAM,
		RecommendedRAM: variant.RecommendedRAM, NativeContext: variant.NativeContext,
		RecommendedContext: variant.RecommendedContext, Capabilities: capabilities,
		Tier: variant.Tier, Source: variant.Source, Gated: variant.Gated,
		Runtime: variant.Runtime, Unverified: variant.Unverified,
	}
}
