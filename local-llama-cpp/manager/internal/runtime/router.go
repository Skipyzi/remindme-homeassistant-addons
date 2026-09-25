package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// RouterModel is one model the llama.cpp router can serve: a canonical ID
// (the catalog variant when the file is known, otherwise the file's stem),
// the file, and the other names a client may use for it.
type RouterModel struct {
	ID      string
	Path    string
	Aliases []string
}

var unsafeIDCharacters = regexp.MustCompile(`[^a-z0-9._-]+`)

// modelID turns a file stem into an identifier safe for an INI section name
// and a request's `model` field.
func modelID(stem string) string {
	id := strings.Trim(unsafeIDCharacters.ReplaceAllString(strings.ToLower(stem), "-"), "-")
	if id == "" {
		return "model"
	}
	return id
}

// ScanModels lists the complete .gguf files in dir as router models.
// Partial downloads and projector sidecars are not models of their own.
// identify maps a file name to its catalog ID, or "" when unknown.
func ScanModels(dir string, identify func(file string) string) ([]RouterModel, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var models []RouterModel
	for _, entry := range entries {
		name := entry.Name()
		lower := strings.ToLower(name)
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(lower, ".gguf") || strings.Contains(lower, "mmproj") {
			continue
		}
		stem := strings.TrimSuffix(name, filepath.Ext(name))
		id := ""
		if identify != nil {
			id = identify(name)
		}
		if id == "" {
			id = modelID(stem)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		model := RouterModel{ID: id, Path: filepath.Join(dir, name)}
		if stem != id {
			model.Aliases = append(model.Aliases, stem)
		}
		models = append(models, model)
	}
	sort.Slice(models, func(left, right int) bool { return models[left].ID < models[right].ID })
	return models, nil
}

// RenderPreset writes the router's model list as llama.cpp preset INI. Only
// identity lives here; runtime flags go on the router's command line, which
// the router passes down to every model it starts.
func RenderPreset(models []RouterModel) string {
	var builder strings.Builder
	for _, model := range models {
		fmt.Fprintf(&builder, "[%s]\nmodel = %s\n", model.ID, model.Path)
		if len(model.Aliases) > 0 {
			fmt.Fprintf(&builder, "alias = %s\n", strings.Join(model.Aliases, ","))
		}
		builder.WriteString("\n")
	}
	return builder.String()
}

// ModelNames resolves whatever a client puts in `model` to a model the router
// serves. Clients that predate the router (a dictation app, an old harness)
// send no name or one of their own; those land on the default model, which is
// exactly what they got when only one model ran.
type ModelNames struct {
	names     map[string]string
	defaultID string
}

func NewModelNames(models []RouterModel, defaultID string) ModelNames {
	names := map[string]string{}
	for _, model := range models {
		keys := append([]string{model.ID, filepath.Base(model.Path)}, model.Aliases...)
		for _, key := range keys {
			names[strings.ToLower(key)] = model.ID
		}
	}
	return ModelNames{names: names, defaultID: defaultID}
}

// Resolve returns the canonical model ID for a requested name, or the default
// model when the name is empty or unknown.
func (names ModelNames) Resolve(requested string) string {
	if id, ok := names.names[strings.ToLower(strings.TrimSpace(requested))]; ok {
		return id
	}
	return names.defaultID
}

func (names ModelNames) Default() string {
	return names.defaultID
}

func (names ModelNames) Has(id string) bool {
	_, ok := names.names[strings.ToLower(id)]
	return ok
}
