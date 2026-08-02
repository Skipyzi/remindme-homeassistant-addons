package generation

import (
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

// Estimate is what the UI shows before a generation run starts. Storage is
// reported as a range because chunk size varies by a factor of two or more
// between plains and a cave-riddled mountain range, and a single number would be
// a false promise.
type Estimate struct {
	Chunks            int64   `json:"chunks"`
	ChunksPerDimension int64  `json:"chunks_per_dimension"`
	Dimensions        int     `json:"dimensions"`
	BytesPerChunk     float64 `json:"bytes_per_chunk"`
	Measured          bool    `json:"measured"`
	MeasuredChunks    int64   `json:"measured_chunks"`
	LowBytes          int64   `json:"low_bytes"`
	HighBytes         int64   `json:"high_bytes"`
	SafeBytes         int64   `json:"safe_bytes"`
	FreeBytes         int64   `json:"free_bytes"`
	Sufficient        bool    `json:"sufficient_space"`
	Notes             []string `json:"notes"`
	BorderWarning     string  `json:"border_warning,omitempty"`
	// EstimatedMinutes is derived from the measured chunk rate of previous runs.
	EstimatedMinutes float64 `json:"estimated_minutes"`
}

// Fallback bytes per chunk when nothing has been measured yet. Derived from
// measuring freshly generated 1.21 worlds on this add-on's own test fixtures;
// it is only used until a real measurement exists, and the estimate says so.
const fallbackBytesPerChunk = 90 * 1024

// ChunkCount returns how many chunks a shape of the given radius covers.
func ChunkCount(shape string, radiusBlocks int) int64 {
	if radiusBlocks <= 0 {
		return 0
	}
	radiusChunks := float64(radiusBlocks) / 16.0
	switch strings.ToLower(shape) {
	case "circle", "oval":
		return int64(math.Ceil(math.Pi * radiusChunks * radiusChunks))
	case "diamond":
		return int64(math.Ceil(2 * radiusChunks * radiusChunks))
	default: // square, rectangle and the rest are bounded by the square
		side := 2*radiusChunks + 1
		return int64(math.Ceil(side * side))
	}
}

// MeasureBytesPerChunk derives the real size of a generated chunk from a world's
// existing region files.
//
// Each .mca file starts with a 4 KiB location table of 1024 entries; an entry with
// a non-zero sector count means that chunk exists. Counting present chunks and
// dividing the directory size by that count gives a measured bytes-per-chunk for
// this specific world and dimension, which beats any hard-coded constant.
func MeasureBytesPerChunk(dimensionDir string) (bytesPerChunk float64, chunks int64, err error) {
	var totalBytes int64
	err = filepath.WalkDir(dimensionDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		totalBytes += info.Size()
		if !strings.HasSuffix(d.Name(), ".mca") {
			return nil
		}
		// Only the Overworld/Nether/End region directories carry chunk terrain;
		// entities and poi region files are counted in the size but their headers
		// would double-count chunks, so only region/ is used for the count.
		if filepath.Base(filepath.Dir(path)) != "region" {
			return nil
		}
		present, err := countChunksInRegion(path)
		if err != nil {
			return nil
		}
		chunks += present
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	if chunks == 0 {
		return 0, 0, nil
	}
	return float64(totalBytes) / float64(chunks), chunks, nil
}

func countChunksInRegion(path string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	header := make([]byte, 4096)
	if _, err := io.ReadFull(f, header); err != nil {
		return 0, err
	}
	var count int64
	for i := 0; i < 1024; i++ {
		entry := header[i*4 : i*4+4]
		// Bytes 0-2 are the offset, byte 3 is the sector count.
		sectors := entry[3]
		offset := uint32(entry[0])<<16 | uint32(entry[1])<<8 | uint32(entry[2])
		if sectors > 0 && offset > 0 {
			count++
		}
	}
	return count, nil
}

// Estimate computes chunk counts and storage requirements for a job.
func (m *Manager) Estimate(params Params) (Estimate, error) {
	if err := params.Validate(); err != nil {
		return Estimate{}, err
	}
	dims := params.dimensionList()
	perDim := ChunkCount(params.Shape, params.RadiusBlocks)
	est := Estimate{
		ChunksPerDimension: perDim,
		Dimensions:         len(dims),
		Chunks:             perDim * int64(len(dims)),
	}

	worldDir, err := m.deps.WorldDir(params.WorldID)
	if err != nil {
		return est, err
	}

	// Prefer a measurement of the target world; fall back to any measurement we
	// have, then to the documented default.
	var samples []float64
	var measuredChunks int64
	for _, dim := range dims {
		if sample, ok, _ := m.deps.Store.GetChunkSample(params.WorldID, dim); ok && sample.BytesPerChunk > 0 {
			samples = append(samples, sample.BytesPerChunk)
			measuredChunks += sample.ChunksMeasured
			continue
		}
		bpc, chunks, err := MeasureBytesPerChunk(filepath.Join(worldDir, dim))
		if err == nil && chunks > 100 {
			samples = append(samples, bpc)
			measuredChunks += chunks
			_ = m.deps.Store.PutChunkSample(store.ChunkSample{
				WorldID: params.WorldID, Dimension: dim,
				BytesPerChunk: bpc, ChunksMeasured: chunks, MeasuredAt: time.Now().UTC(),
			})
		}
	}
	if len(samples) > 0 {
		var sum float64
		for _, s := range samples {
			sum += s
		}
		est.BytesPerChunk = sum / float64(len(samples))
		est.Measured = true
		est.MeasuredChunks = measuredChunks
		est.Notes = append(est.Notes, fmt.Sprintf(
			"based on %d already generated chunks in this world (%.0f KiB per chunk)",
			measuredChunks, est.BytesPerChunk/1024))
	} else {
		est.BytesPerChunk = fallbackBytesPerChunk
		est.Notes = append(est.Notes,
			"no generated chunks to measure yet, using a conservative default; generate a small area first for an accurate estimate")
	}

	// The spread reflects how much terrain size varies with biome and cave
	// density; it is deliberately asymmetric because underestimating is worse.
	est.LowBytes = int64(float64(est.Chunks) * est.BytesPerChunk * 0.75)
	est.HighBytes = int64(float64(est.Chunks) * est.BytesPerChunk * 1.40)

	policy := m.policyFor(params.Profile)
	margin := float64(policy.StorageSafetyMarginPercent)
	if margin < 0 {
		margin = 0
	}
	est.SafeBytes = int64(float64(est.HighBytes) * (1 + margin/100))
	system := m.deps.Stats().DiskFreeBytes
	est.FreeBytes = system
	est.Sufficient = system > est.SafeBytes && float64(system)/(1<<30) > policy.PauseWhen.DiskFreeBelowGB
	if system == 0 {
		est.Sufficient = false
		est.Notes = append(est.Notes, "free disk space is unknown; generation will not start")
	}

	// Chunk rate from the last completed job, if there is one.
	if rate := m.lastKnownRate(); rate > 0 {
		est.EstimatedMinutes = float64(est.Chunks) / rate / 60
		est.Notes = append(est.Notes, fmt.Sprintf("time estimate assumes %.0f chunks per second, measured on this server", rate))
	}

	if params.BorderRadiusBlocks > 0 {
		generatedUsable := params.RadiusBlocks - params.SafetyMarginBlocks
		if params.BorderRadiusBlocks > generatedUsable {
			est.BorderWarning = fmt.Sprintf(
				"the playable world border (%d blocks) reaches past the generated area minus the safety margin (%d blocks); players would generate terrain live",
				params.BorderRadiusBlocks, generatedUsable)
		}
	}
	return est, nil
}

func (m *Manager) lastKnownRate() float64 {
	jobs, err := m.deps.Store.ListJobs(20)
	if err != nil {
		return 0
	}
	for _, job := range jobs {
		if job.Status == store.JobCompleted && job.Rate > 0 {
			return job.Rate
		}
	}
	return 0
}
