package stats

// MemoryAdvice is the answer to "how big may the heap be on this machine".
//
// The instinct is to give Minecraft all free memory; the mistake is that the
// page cache is what makes region-file IO fast, and a heap that squeezes it
// out trades invisible cache for visible autosave stutter. The budget below
// reserves room for Home Assistant plus the OS and a page-cache floor, and
// treats everything else as heap plus the JVM's own off-heap overhead.
type MemoryAdvice struct {
	TotalMB int `json:"total_mb"`
	// RecommendedMaxHeapMB is the ceiling, not a target: a server with three
	// players is happier with 2048 and more cache.
	RecommendedMaxHeapMB int    `json:"recommended_max_heap_mb"`
	ConfiguredMaxHeapMB  int    `json:"configured_max_heap_mb"`
	Exceeded             bool   `json:"exceeded"`
	Reason               string `json:"reason"`
}

const (
	// What the rest of the machine needs, in MB. Home Assistant with a few
	// integrations plus the OS sits near 2 GB on a Pi; the page-cache floor is
	// what keeps region-file reads out of the storage queue.
	systemReserveMB = 2048
	cacheFloorMB    = 2048
	jvmOverheadMB   = 512
	adviceFloorMB   = 1024
)

// AdviseMemory computes the heap ceiling for a machine with totalBytes of RAM.
func AdviseMemory(totalBytes int64, configuredMaxMB int) MemoryAdvice {
	advice := MemoryAdvice{
		TotalMB:             int(totalBytes / (1024 * 1024)),
		ConfiguredMaxHeapMB: configuredMaxMB,
	}
	if advice.TotalMB <= 0 {
		return advice
	}
	recommended := advice.TotalMB - systemReserveMB - cacheFloorMB - jvmOverheadMB
	if recommended < adviceFloorMB {
		recommended = adviceFloorMB
	}
	advice.RecommendedMaxHeapMB = recommended
	advice.Exceeded = configuredMaxMB > recommended
	advice.Reason = "leaves ~2 GB for Home Assistant and the OS, ~2 GB of page cache for world file IO, " +
		"and ~0.5 GB for the JVM outside its heap"
	return advice
}
