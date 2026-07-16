package download

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"remindme.local/model-manager/internal/catalog"
)

const (
	CodeAuthenticationRequired = "authentication_required"
	CodeRepositoryUnavailable  = "repository_unavailable"
	CodeDownloadInterrupted    = "download_interrupted"
	CodeSizeMismatch           = "size_mismatch"
	CodeInvalidGGUF            = "invalid_gguf"
	CodeChecksumMismatch       = "checksum_mismatch"
	CodeUnsafeRedirect         = "unsafe_redirect"
)

const defaultMaxBytes = int64(16 * 1024 * 1024 * 1024)

type Progress struct {
	BytesDone  int64 `json:"bytesDone"`
	BytesTotal int64 `json:"bytesTotal"`
}

type Result struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

type Metadata struct {
	Bytes int64 `json:"bytes"`
}

type Error struct {
	Code        string
	SafeMessage string
	Retryable   bool
}

func (err *Error) Error() string {
	return err.SafeMessage
}

func AsError(err error, target **Error) bool {
	return errors.As(err, target)
}

type Downloader struct {
	Client      *http.Client
	ModelDir    string
	ResolveBase string
	MaxBytes    int64
	Now         func() time.Time
}

func (downloader Downloader) Inspect(ctx context.Context, variant catalog.Variant, token string) (Metadata, error) {
	if _, err := catalog.ValidateCustom(catalog.CustomInput{Repo: variant.Repo, File: variant.File}); err != nil {
		return Metadata{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face repository or GGUF filename is invalid."}
	}
	requestURL := strings.TrimRight(downloader.resolveBase(), "/") + "/" + variant.Repo + "/resolve/main/" + url.PathEscape(variant.File)
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, requestURL, nil)
	if err != nil {
		return Metadata{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face model address is invalid."}
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := downloader.httpClient().Do(request)
	if err != nil {
		var safeErr *Error
		if errors.As(err, &safeErr) {
			return Metadata{}, safeErr
		}
		return Metadata{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face model file is unavailable.", Retryable: true}
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return Metadata{}, &Error{Code: CodeAuthenticationRequired, SafeMessage: "Configure Hugging Face access and accept the model licence first."}
	}
	if response.StatusCode != http.StatusOK {
		return Metadata{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face model file is unavailable.", Retryable: response.StatusCode >= 500}
	}
	rawSize := response.Header.Get("X-Linked-Size")
	if rawSize == "" {
		rawSize = response.Header.Get("Content-Length")
	}
	size, parseErr := strconv.ParseInt(rawSize, 10, 64)
	maxBytes := downloader.MaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	if parseErr != nil || size <= 0 || size > maxBytes {
		return Metadata{}, &Error{Code: CodeSizeMismatch, SafeMessage: "The custom model does not report a safe download size."}
	}
	return Metadata{Bytes: size}, nil
}

func (downloader Downloader) Download(ctx context.Context, variant catalog.Variant, token string, progress func(Progress)) (Result, error) {
	if _, err := catalog.ValidateCustom(catalog.CustomInput{Repo: variant.Repo, File: variant.File}); err != nil {
		return Result{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face repository or GGUF filename is invalid."}
	}
	if variant.ExpectedBytes <= 0 {
		return Result{}, &Error{Code: CodeSizeMismatch, SafeMessage: "The model does not have a verified download size."}
	}
	maxBytes := downloader.MaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	if variant.ExpectedBytes > maxBytes {
		return Result{}, &Error{Code: CodeSizeMismatch, SafeMessage: "The model exceeds the configured download limit."}
	}
	if err := os.MkdirAll(downloader.ModelDir, 0o700); err != nil {
		return Result{}, fmt.Errorf("create model directory: %w", err)
	}
	partial := filepath.Join(downloader.ModelDir, variant.File+".partial")
	final := filepath.Join(downloader.ModelDir, variant.File)
	start := int64(0)
	if info, err := os.Stat(partial); err == nil {
		start = info.Size()
		if start > variant.ExpectedBytes {
			if removeErr := os.Remove(partial); removeErr != nil {
				return Result{}, fmt.Errorf("remove oversized partial download: %w", removeErr)
			}
			start = 0
		}
	}

	requestURL := strings.TrimRight(downloader.resolveBase(), "/") + "/" + variant.Repo + "/resolve/main/" + url.PathEscape(variant.File)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return Result{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face model address is invalid."}
	}
	if start > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", start))
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := downloader.httpClient().Do(request)
	if err != nil {
		var safeErr *Error
		if errors.As(err, &safeErr) {
			return Result{}, safeErr
		}
		if ctx.Err() != nil {
			return Result{}, &Error{Code: CodeDownloadInterrupted, SafeMessage: "Download cancelled; the partial file can be resumed.", Retryable: true}
		}
		return Result{}, &Error{Code: CodeDownloadInterrupted, SafeMessage: "Download interrupted; it can be resumed.", Retryable: true}
	}
	defer response.Body.Close()

	switch response.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return Result{}, &Error{Code: CodeAuthenticationRequired, SafeMessage: "Configure Hugging Face access and accept the model licence first."}
	case http.StatusNotFound:
		return Result{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face model file was not found."}
	case http.StatusOK, http.StatusPartialContent:
	default:
		return Result{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face model file is unavailable.", Retryable: response.StatusCode >= 500}
	}

	appendPartial := start > 0 && response.StatusCode == http.StatusPartialContent
	flags := os.O_CREATE | os.O_WRONLY
	if appendPartial {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
		start = 0
	}
	file, err := os.OpenFile(partial, flags, 0o600)
	if err != nil {
		return Result{}, fmt.Errorf("open partial model: %w", err)
	}
	written, copyErr := copyWithProgress(ctx, file, response.Body, start, variant.ExpectedBytes, maxBytes, progress, downloader.clock())
	if syncErr := file.Sync(); copyErr == nil {
		copyErr = syncErr
	}
	if closeErr := file.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		if ctx.Err() != nil {
			return Result{}, &Error{Code: CodeDownloadInterrupted, SafeMessage: "Download cancelled; the partial file can be resumed.", Retryable: true}
		}
		return Result{}, &Error{Code: CodeDownloadInterrupted, SafeMessage: "Download interrupted; it can be resumed.", Retryable: true}
	}
	if written != variant.ExpectedBytes {
		return Result{}, &Error{Code: CodeSizeMismatch, SafeMessage: "Downloaded model size did not match its catalog metadata.", Retryable: true}
	}
	if err := ValidateGGUF(partial, variant.ExpectedBytes); err != nil {
		_ = os.Remove(partial)
		return Result{}, err
	}
	if variant.SHA256 != "" {
		if err := verifySHA256(partial, variant.SHA256); err != nil {
			_ = os.Remove(partial)
			return Result{}, err
		}
	}
	if err := os.Chmod(partial, 0o600); err != nil {
		return Result{}, fmt.Errorf("protect model file: %w", err)
	}
	if err := os.Rename(partial, final); err != nil {
		return Result{}, fmt.Errorf("finalize model file: %w", err)
	}
	return Result{Path: final, Bytes: written}, nil
}

func (downloader Downloader) resolveBase() string {
	if downloader.ResolveBase != "" {
		return downloader.ResolveBase
	}
	return "https://huggingface.co"
}

func (downloader Downloader) clock() func() time.Time {
	if downloader.Now != nil {
		return downloader.Now
	}
	return time.Now
}

func (downloader Downloader) httpClient() *http.Client {
	base := downloader.Client
	if base == nil {
		base = &http.Client{Timeout: 0}
	}
	clone := *base
	prior := base.CheckRedirect
	clone.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if !allowedRedirectHost(request.URL.Hostname()) {
			return &Error{Code: CodeUnsafeRedirect, SafeMessage: "Hugging Face redirected the download to an unapproved host."}
		}
		if prior != nil {
			return prior(request, via)
		}
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		return nil
	}
	return &clone
}

func allowedRedirectHost(host string) bool {
	host = strings.ToLower(host)
	return host == "huggingface.co" || host == "hf.co" || host == "cdn-lfs.huggingface.co" || strings.HasSuffix(host, ".xethub.hf.co")
}

func copyWithProgress(ctx context.Context, destination io.Writer, source io.Reader, start, total, maxBytes int64, progress func(Progress), now func() time.Time) (int64, error) {
	buffer := make([]byte, 128*1024)
	written := start
	lastUpdate := time.Time{}
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		count, readErr := source.Read(buffer)
		if count > 0 {
			written += int64(count)
			if written > total || written > maxBytes {
				return written, errors.New("download exceeded expected size")
			}
			if _, err := destination.Write(buffer[:count]); err != nil {
				return written, err
			}
			current := now()
			if progress != nil && (lastUpdate.IsZero() || current.Sub(lastUpdate) >= 200*time.Millisecond || written == total) {
				progress(Progress{BytesDone: written, BytesTotal: total})
				lastUpdate = current
			}
		}
		if errors.Is(readErr, io.EOF) {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

func ValidateGGUF(path string, expectedBytes int64) error {
	file, err := os.Open(path)
	if err != nil {
		return &Error{Code: CodeInvalidGGUF, SafeMessage: "Downloaded model could not be opened for validation."}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() != expectedBytes {
		return &Error{Code: CodeSizeMismatch, SafeMessage: "Downloaded model size did not match its catalog metadata."}
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(file, header); err != nil || string(header) != "GGUF" {
		return &Error{Code: CodeInvalidGGUF, SafeMessage: "Downloaded file is not a valid GGUF model."}
	}
	return nil
}

func verifySHA256(path, expected string) error {
	file, err := os.Open(path)
	if err != nil {
		return &Error{Code: CodeChecksumMismatch, SafeMessage: "Downloaded model checksum could not be verified."}
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return &Error{Code: CodeChecksumMismatch, SafeMessage: "Downloaded model checksum could not be verified."}
	}
	actual, decodeErr := hex.DecodeString(hex.EncodeToString(hash.Sum(nil)))
	wanted, expectedErr := hex.DecodeString(strings.ToLower(expected))
	if decodeErr != nil || expectedErr != nil || len(actual) != len(wanted) || subtle.ConstantTimeCompare(actual, wanted) != 1 {
		return &Error{Code: CodeChecksumMismatch, SafeMessage: "Downloaded model checksum did not match its catalog metadata."}
	}
	return nil
}
