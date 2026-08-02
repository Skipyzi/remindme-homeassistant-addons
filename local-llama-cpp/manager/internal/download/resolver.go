package download

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"remindme.local/model-manager/internal/catalog"
)

const maxRepositoryResponseBytes = 8 * 1024 * 1024

type repositoryFile struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	LFS  *struct {
		Size int64 `json:"size"`
	} `json:"lfs,omitempty"`
}

var splitGGUFPattern = regexp.MustCompile(`(?i)-[0-9]{5}-of-[0-9]{5}\.gguf$`)

func (downloader Downloader) Resolve(ctx context.Context, rawRepo, rawFile, token string, curated catalog.Catalog) (catalog.Variant, error) {
	repo, quant, err := splitRepoQuant(rawRepo)
	if err != nil {
		return catalog.Variant{}, repositoryError(err.Error())
	}
	if _, err := catalog.ValidateCustom(catalog.CustomInput{Repo: repo, File: "model.gguf"}); err != nil {
		return catalog.Variant{}, repositoryError("The Hugging Face repository is invalid.")
	}

	if rawFile != "" {
		quant = ""
		if _, err := catalog.ValidateCustom(catalog.CustomInput{Repo: repo, File: rawFile}); err != nil {
			return catalog.Variant{}, repositoryError("The Hugging Face repository or GGUF filename is invalid.")
		}
		for _, variant := range curated.Variants {
			if variant.Repo == repo && variant.File == rawFile {
				return variant, nil
			}
		}
	}

	file := rawFile
	if file == "" {
		if variant, ok, selectErr := selectCuratedVariant(curated, repo, quant); selectErr != nil {
			return catalog.Variant{}, selectErr
		} else if ok {
			return variant, nil
		}
		files, listErr := downloader.listRepoFiles(ctx, repo, token)
		if listErr != nil {
			return catalog.Variant{}, listErr
		}
		file, err = selectModelFile(files, quant)
		if err != nil {
			return catalog.Variant{}, err
		}
	}

	variant, err := catalog.ValidateCustom(catalog.CustomInput{Repo: repo, File: file})
	if err != nil {
		return catalog.Variant{}, repositoryError("The Hugging Face repository or GGUF filename is invalid.")
	}
	metadata, err := downloader.Inspect(ctx, variant, token)
	if err != nil {
		return catalog.Variant{}, err
	}
	variant.ExpectedBytes = metadata.Bytes
	variant.Parameters = max(metadata.Bytes*2, 1)
	variant.MinimumRAM = metadata.Bytes + 2*1024*1024*1024
	variant.RecommendedRAM = variant.MinimumRAM + 1024*1024*1024
	return variant, nil
}

func splitRepoQuant(raw string) (string, string, error) {
	parts := strings.Split(raw, ":")
	if len(parts) == 0 || len(parts) > 2 || parts[0] == "" {
		return "", "", errors.New("repository must use owner/repo[:quant]")
	}
	if len(parts) == 1 {
		return parts[0], "", nil
	}
	if parts[1] == "" {
		return "", "", errors.New("quantization suffix is empty")
	}
	return parts[0], parts[1], nil
}

func selectCuratedVariant(modelCatalog catalog.Catalog, repo, quant string) (catalog.Variant, bool, error) {
	variants := make([]catalog.Variant, 0)
	files := make([]repositoryFile, 0)
	for _, variant := range modelCatalog.Variants {
		if variant.Repo != repo {
			continue
		}
		variants = append(variants, variant)
		files = append(files, repositoryFile{Type: "file", Path: variant.File, Size: variant.ExpectedBytes})
	}
	if len(variants) == 0 {
		return catalog.Variant{}, false, nil
	}
	selected, err := selectModelFile(files, quant)
	if err != nil {
		return catalog.Variant{}, false, err
	}
	for _, variant := range variants {
		if variant.File == selected {
			return variant, true, nil
		}
	}
	return catalog.Variant{}, false, nil
}

func (downloader Downloader) listRepoFiles(ctx context.Context, repo, token string) ([]repositoryFile, error) {
	base := strings.TrimRight(downloader.APIBase, "/")
	if base == "" {
		base = "https://huggingface.co"
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return nil, repositoryError("The Hugging Face repository address is invalid.")
	}
	next := base + "/api/models/" + repo + "/tree/main?recursive=true&expand=false&limit=1000"
	files := make([]repositoryFile, 0)
	for page := 0; next != "" && page < 10; page++ {
		requestURL, parseErr := url.Parse(next)
		if parseErr != nil || !trustedRepositoryPage(baseURL, requestURL) {
			return nil, &Error{Code: CodeUnsafeRedirect, SafeMessage: "Hugging Face returned an unapproved repository page."}
		}
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
		if requestErr != nil {
			return nil, repositoryError("The Hugging Face repository address is invalid.")
		}
		if token != "" && strings.EqualFold(baseURL.Hostname(), requestURL.Hostname()) {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		request.Header.Set("Accept", "application/json")
		response, requestErr := downloader.httpClient().Do(request)
		if requestErr != nil {
			var safeErr *Error
			if errors.As(requestErr, &safeErr) {
				return nil, safeErr
			}
			return nil, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face repository is unavailable.", Retryable: true}
		}
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			response.Body.Close()
			return nil, &Error{Code: CodeAuthenticationRequired, SafeMessage: "Configure Hugging Face access and accept the model licence first."}
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return nil, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face repository is unavailable.", Retryable: response.StatusCode >= 500}
		}
		var pageFiles []repositoryFile
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, maxRepositoryResponseBytes)).Decode(&pageFiles)
		next = nextPage(response.Header.Get("Link"))
		response.Body.Close()
		if decodeErr != nil {
			return nil, repositoryError("The Hugging Face repository file list is invalid.")
		}
		files = append(files, pageFiles...)
	}
	if next != "" {
		return nil, repositoryError("The Hugging Face repository file list has too many pages.")
	}
	return files, nil
}

func trustedRepositoryPage(base, candidate *url.URL) bool {
	if base == nil || candidate == nil || candidate.User != nil {
		return false
	}
	if strings.EqualFold(base.Scheme, candidate.Scheme) && strings.EqualFold(base.Host, candidate.Host) {
		return true
	}
	return candidate.Scheme == "https" && trustedHuggingFaceHost(candidate.Hostname())
}

func nextPage(linkHeader string) string {
	for _, entry := range strings.Split(linkHeader, ",") {
		parts := strings.Split(entry, ";")
		if len(parts) < 2 || !strings.Contains(strings.Join(parts[1:], ";"), `rel="next"`) {
			continue
		}
		return strings.Trim(strings.TrimSpace(parts[0]), "<>")
	}
	return ""
}

func selectModelFile(files []repositoryFile, quant string) (string, error) {
	candidates := make([]string, 0)
	for _, file := range files {
		if file.Type == "file" && isPrimaryGGUF(file.Path) {
			candidates = append(candidates, file.Path)
		}
	}
	sort.Strings(candidates)

	if quant != "" {
		matches := matchingQuantization(candidates, quant)
		return uniqueModelFile(matches, candidates, quant)
	}
	for _, preferred := range []string{"Q4_K_M", "Q8_0"} {
		matches := matchingQuantization(candidates, preferred)
		if len(matches) > 0 {
			return uniqueModelFile(matches, candidates, preferred)
		}
	}
	return uniqueModelFile(candidates, candidates, "")
}

func matchingQuantization(files []string, quant string) []string {
	pattern := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(quant) + `[.-]`)
	matches := make([]string, 0)
	for _, file := range files {
		if pattern.MatchString(file) {
			matches = append(matches, file)
		}
	}
	return matches
}

func uniqueModelFile(matches, available []string, quant string) (string, error) {
	if len(matches) == 0 {
		message := "No supported GGUF model was found in the Hugging Face repository."
		if quant != "" {
			message = fmt.Sprintf("Quantization %q was not found. Available GGUF files: %s", quant, boundedFileList(available))
		}
		return "", &Error{Code: CodeQuantizationNotFound, SafeMessage: message}
	}
	if len(matches) > 1 {
		return "", &Error{Code: CodeAmbiguousModel, SafeMessage: "The model selection matches multiple GGUF files; configure an exact filename."}
	}
	if splitGGUFPattern.MatchString(matches[0]) {
		return "", &Error{Code: CodeSplitModelUnsupported, SafeMessage: "Split GGUF models are not supported; configure a single-file GGUF."}
	}
	return matches[0], nil
}

func isPrimaryGGUF(path string) bool {
	lower := strings.ToLower(path)
	if !strings.HasSuffix(lower, ".gguf") || strings.Contains(path, "/") {
		return false
	}
	for _, excluded := range []string{"mmproj", "imatrix", "mtp-", "eagle3-", "dflash-"} {
		if strings.Contains(lower, excluded) {
			return false
		}
	}
	return true
}

func boundedFileList(files []string) string {
	if len(files) == 0 {
		return "none"
	}
	if len(files) > 10 {
		files = files[:10]
	}
	return strings.Join(files, ", ")
}

func repositoryError(message string) *Error {
	return &Error{Code: CodeRepositoryUnavailable, SafeMessage: message}
}

func resolveURL(base, repo, file string) string {
	return strings.TrimRight(base, "/") + "/" + repo + "/resolve/main/" + url.PathEscape(file)
}
