// Package javaflags holds the JVM flag profiles. They are about the JVM rather
// than about any particular server flavour, so every backend shares them.
package javaflags

import "fmt"

// FlagProfile returns JVM flags for a named profile.
//
// These are G1 settings validated against Java 21 on aarch64 with a small heap
// (2-4 GB), which is the situation on a Raspberry Pi 5 that also runs Home
// Assistant. Two deliberate departures from the flag lists commonly copied
// around Minecraft communities:
//
//   - AlwaysPreTouch is only enabled in the "performance" profile. It commits the
//     whole heap at startup, which is good for latency but takes memory away from
//     Home Assistant for as long as the server runs.
//   - No marker system properties (-Dusing.*.flags) are set: they do nothing.
//
// A young generation of 30-40% with MaxTenuringThreshold=1 keeps Paper's very
// high allocation rate of short-lived objects out of the old generation, which is
// what actually causes long pauses on small heaps. G1HeapRegionSize is chosen so
// a small heap still gets a useful number of regions.
func FlagProfile(name string, heapMB int) ([]string, error) {
	region := "4M"
	switch {
	case heapMB >= 4096:
		region = "8M"
	case heapMB >= 2048:
		region = "4M"
	default:
		region = "2M"
	}

	common := []string{
		"-XX:+UseG1GC",
		"-XX:+ParallelRefProcEnabled",
		"-XX:+UnlockExperimentalVMOptions",
		"-XX:+DisableExplicitGC",
		"-XX:+PerfDisableSharedMem",
		"-XX:G1HeapRegionSize=" + region,
		"-XX:MaxTenuringThreshold=1",
		"-XX:SurvivorRatio=32",
		// A hard cap on GC worker threads: the Pi has four cores that Home
		// Assistant also needs, and unbounded GC threads cause stutter.
		"-XX:ParallelGCThreads=3",
		"-XX:ConcGCThreads=1",
	}

	switch name {
	case "low_power":
		return append(common,
			"-XX:MaxGCPauseMillis=200",
			"-XX:G1NewSizePercent=20",
			"-XX:G1MaxNewSizePercent=35",
			"-XX:G1ReservePercent=15",
			"-XX:InitiatingHeapOccupancyPercent=20",
			// Deduplicating strings costs a little CPU and saves real memory,
			// which is the right trade when the heap is only 2 GB.
			"-XX:+UseStringDeduplication",
		), nil
	case "balanced", "":
		return append(common,
			"-XX:MaxGCPauseMillis=150",
			"-XX:G1NewSizePercent=30",
			"-XX:G1MaxNewSizePercent=40",
			"-XX:G1ReservePercent=20",
			"-XX:InitiatingHeapOccupancyPercent=25",
		), nil
	case "performance":
		return append(common,
			"-XX:MaxGCPauseMillis=100",
			"-XX:G1NewSizePercent=30",
			"-XX:G1MaxNewSizePercent=50",
			"-XX:G1ReservePercent=20",
			"-XX:InitiatingHeapOccupancyPercent=15",
			"-XX:+AlwaysPreTouch",
		), nil
	case "custom":
		// The caller supplies validated flags.
		return nil, nil
	default:
		return nil, fmt.Errorf("unknown JVM flag profile %q", name)
	}
}

// FlagProfiles lists the selectable profiles for the UI.
func FlagProfiles() []string { return []string{"low_power", "balanced", "performance", "custom"} }
