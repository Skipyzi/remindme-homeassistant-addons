//go:build !linux

package stats

import (
	"os"
	"runtime"
)

// The add-on always runs on Linux. These stubs exist so the controller can be
// built and exercised on a development machine; the dashboard then shows the
// values it can obtain (process memory, disk via the fallback below) and zero for
// the Linux-only sensors.

func readMem() (total, available int64) { return 0, 0 }

func cpuTimes() (busy, total float64) { return 0, 0 }

func loadAvg() [3]float64 { return [3]float64{} }

func cpuTemperature() float64 { return 0 }

func thermalThrottled() (bool, float64) { return false, 0 }

func diskUsage(path string) (total, free int64) {
	// Without platform APIs there is nothing reliable to report; the generation
	// disk guard treats zero as "unknown" and refuses to start rather than
	// assuming there is space.
	if _, err := os.Stat(path); err != nil {
		return 0, 0
	}
	return 0, 0
}

func processStats(pid int) (rss int64, cpuJiffies float64, threads int) {
	return 0, 0, runtime.NumGoroutine()
}

func clockTicks() float64 { return 100 }

func cpuCount() int { return runtime.NumCPU() }
