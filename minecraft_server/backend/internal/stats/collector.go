// Package stats samples system, process and JVM metrics and caches expensive
// directory sizes so the dashboard can refresh once per second without doing any
// real work.
package stats

import (
	"context"
	"log/slog"
	"runtime"
	"sync"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

// System is a point-in-time view of the host.
type System struct {
	CPUPercent       float64    `json:"cpu_percent"`
	CPUCount         int        `json:"cpu_count"`
	LoadAvg          [3]float64 `json:"load_avg"`
	MemTotalBytes    int64      `json:"mem_total_bytes"`
	MemAvailBytes    int64      `json:"mem_available_bytes"`
	MemUsedPercent   float64    `json:"mem_used_percent"`
	CPUTemperatureC  float64    `json:"cpu_temperature_c"`
	ThermalThrottled bool       `json:"thermal_throttled"`
	FreqRatio        float64    `json:"frequency_ratio"`
	DiskTotalBytes   int64      `json:"disk_total_bytes"`
	DiskFreeBytes    int64      `json:"disk_free_bytes"`
	ControllerRSS    int64      `json:"controller_rss_bytes"`
	ServerRSS        int64      `json:"server_rss_bytes"`
	ServerCPUPercent float64    `json:"server_cpu_percent"`
	ServerThreads    int        `json:"server_threads"`
	SampledAt        string     `json:"sampled_at"`
}

// SizeEntry is a cached directory size with its age, so the UI can show
// "measured 3 minutes ago" instead of pretending it is live.
type SizeEntry struct {
	Bytes     int64  `json:"bytes"`
	Files     int64  `json:"files"`
	UpdatedAt string `json:"updated_at"`
	Stale     bool   `json:"stale"`
}

type Deps struct {
	Store    *store.Store
	Log      *slog.Logger
	DiskPath string
	// PID returns the current Minecraft process id, or 0.
	PID func() int
	// SizeTargets are the directories whose sizes are refreshed in the
	// background, keyed by a stable name used by the API.
	SizeTargets func() map[string]string
	// Interval between system samples.
	Interval time.Duration
	// SizeInterval between full size refreshes.
	SizeInterval time.Duration
}

type Collector struct {
	deps Deps
	log  *slog.Logger

	mu       sync.RWMutex
	system   System
	sizes    map[string]SizeEntry
	dirtySet map[string]string

	prevBusy, prevTotal float64
	prevProcJiffies     float64
	prevProcAt          time.Time
}

func New(d Deps) *Collector {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Interval <= 0 {
		d.Interval = 5 * time.Second
	}
	if d.SizeInterval <= 0 {
		d.SizeInterval = 10 * time.Minute
	}
	c := &Collector{
		deps:     d,
		log:      d.Log.With("component", "stats"),
		sizes:    map[string]SizeEntry{},
		dirtySet: map[string]string{},
	}
	c.loadCachedSizes()
	return c
}

func (c *Collector) loadCachedSizes() {
	if c.deps.SizeTargets == nil {
		return
	}
	for name, path := range c.deps.SizeTargets() {
		if rec, ok, err := c.deps.Store.GetSize(path); err == nil && ok {
			c.sizes[name] = SizeEntry{
				Bytes:     rec.Bytes,
				Files:     rec.Files,
				UpdatedAt: rec.UpdatedAt.UTC().Format(time.RFC3339),
				Stale:     time.Since(rec.UpdatedAt) > c.deps.SizeInterval,
			}
		}
	}
}

// Run samples until the context is cancelled.
func (c *Collector) Run(ctx context.Context) {
	c.sample()
	go c.refreshSizes(ctx, true)

	ticker := time.NewTicker(c.deps.Interval)
	sizeTicker := time.NewTicker(c.deps.SizeInterval)
	defer ticker.Stop()
	defer sizeTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.sample()
			c.drainDirty(ctx)
		case <-sizeTicker.C:
			c.refreshSizes(ctx, false)
		}
	}
}

func (c *Collector) sample() {
	busy, total := cpuTimes()
	memTotal, memAvail := readMem()
	temp := cpuTemperature()
	throttled, ratio := thermalThrottled()
	diskTotal, diskFree := diskUsage(c.deps.DiskPath)

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	sys := System{
		CPUCount:         cpuCount(),
		LoadAvg:          loadAvg(),
		MemTotalBytes:    memTotal,
		MemAvailBytes:    memAvail,
		CPUTemperatureC:  temp,
		ThermalThrottled: throttled,
		FreqRatio:        ratio,
		DiskTotalBytes:   diskTotal,
		DiskFreeBytes:    diskFree,
		ControllerRSS:    int64(mem.Sys),
		SampledAt:        time.Now().UTC().Format(time.RFC3339),
	}
	if memTotal > 0 {
		sys.MemUsedPercent = float64(memTotal-memAvail) / float64(memTotal) * 100
	}

	c.mu.Lock()
	if c.prevTotal > 0 && total > c.prevTotal {
		sys.CPUPercent = (busy - c.prevBusy) / (total - c.prevTotal) * 100
	}
	c.prevBusy, c.prevTotal = busy, total

	if c.deps.PID != nil {
		if pid := c.deps.PID(); pid > 0 {
			rss, jiffies, threads := processStats(pid)
			sys.ServerRSS = rss
			sys.ServerThreads = threads
			now := time.Now()
			if !c.prevProcAt.IsZero() && jiffies >= c.prevProcJiffies {
				elapsed := now.Sub(c.prevProcAt).Seconds()
				cores := float64(sys.CPUCount)
				if elapsed > 0 && cores > 0 {
					sys.ServerCPUPercent = (jiffies - c.prevProcJiffies) / clockTicks() / elapsed / cores * 100
				}
			}
			c.prevProcJiffies, c.prevProcAt = jiffies, now
		} else {
			c.prevProcJiffies, c.prevProcAt = 0, time.Time{}
		}
	}
	// Keep the previous temperature when a reading fails so a transient sysfs
	// hiccup does not look like the Pi suddenly cooled to 0 degrees.
	if sys.CPUTemperatureC == 0 && c.system.CPUTemperatureC > 0 {
		sys.CPUTemperatureC = c.system.CPUTemperatureC
	}
	c.system = sys
	c.mu.Unlock()
}

func (c *Collector) System() System {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.system
}

// Sizes returns every cached size.
func (c *Collector) Sizes() map[string]SizeEntry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]SizeEntry, len(c.sizes))
	for k, v := range c.sizes {
		out[k] = v
	}
	return out
}

func (c *Collector) Size(name string) SizeEntry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sizes[name]
}

// Invalidate schedules a size refresh for one target. Filesystem operations call
// this so the dashboard reflects a new world or backup within seconds without
// ever scanning on the request path.
func (c *Collector) Invalidate(name, path string) {
	c.mu.Lock()
	c.dirtySet[name] = path
	c.mu.Unlock()
}

func (c *Collector) drainDirty(ctx context.Context) {
	c.mu.Lock()
	dirty := c.dirtySet
	c.dirtySet = map[string]string{}
	c.mu.Unlock()
	for name, path := range dirty {
		if ctx.Err() != nil {
			return
		}
		c.measure(name, path)
	}
}

func (c *Collector) refreshSizes(ctx context.Context, initial bool) {
	if c.deps.SizeTargets == nil {
		return
	}
	for name, path := range c.deps.SizeTargets() {
		if ctx.Err() != nil {
			return
		}
		if initial {
			if entry := c.Size(name); entry.UpdatedAt != "" && !entry.Stale {
				continue
			}
		}
		c.measure(name, path)
	}
}

func (c *Collector) measure(name, path string) {
	start := time.Now()
	bytes, files, err := atomicfs.DirSize(path)
	if err != nil {
		c.log.Debug("size measurement failed", "path", path, "error", err)
		return
	}
	if err := c.deps.Store.PutSize(path, bytes, files); err != nil {
		c.log.Debug("could not cache size", "path", path, "error", err)
	}
	c.mu.Lock()
	c.sizes[name] = SizeEntry{
		Bytes:     bytes,
		Files:     files,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	c.mu.Unlock()
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		c.log.Info("size measurement was slow", "path", path, "duration", elapsed.String())
	}
}

// DiskFreeGB is used by the generation guards.
func (c *Collector) DiskFreeGB() float64 {
	return float64(c.System().DiskFreeBytes) / (1 << 30)
}
