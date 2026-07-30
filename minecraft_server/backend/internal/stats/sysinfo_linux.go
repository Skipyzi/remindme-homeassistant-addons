//go:build linux

package stats

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// readMem returns total and available memory in bytes from /proc/meminfo.
// MemAvailable is the kernel's own estimate and is far more useful than MemFree,
// which excludes reclaimable page cache.
func readMem() (total, available int64) {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = value * 1024
		case "MemAvailable:":
			available = value * 1024
		}
	}
	return total, available
}

// cpuTimes returns busy and total jiffies from /proc/stat. CPU percentage is the
// delta between two samples, so a single reading means nothing on its own.
func cpuTimes() (busy, total float64) {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		var idle float64
		for i, f := range fields {
			v, err := strconv.ParseFloat(f, 64)
			if err != nil {
				continue
			}
			total += v
			// Fields 3 and 4 are idle and iowait.
			if i == 3 || i == 4 {
				idle += v
			}
		}
		return total - idle, total
	}
	return 0, 0
}

func loadAvg() [3]float64 {
	var out [3]float64
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return out
	}
	fields := strings.Fields(string(raw))
	for i := 0; i < 3 && i < len(fields); i++ {
		out[i], _ = strconv.ParseFloat(fields[i], 64)
	}
	return out
}

// cpuTemperature reads the SoC temperature. On a Raspberry Pi the CPU zone is
// thermal_zone0, but all zones are scanned so this also works on other boards.
func cpuTemperature() float64 {
	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	best := 0.0
	for _, zone := range zones {
		raw, err := os.ReadFile(zone)
		if err != nil {
			continue
		}
		milli, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
		if err != nil {
			continue
		}
		celsius := milli / 1000
		if celsius <= 0 || celsius > 150 {
			continue
		}
		if celsius > best {
			best = celsius
		}
	}
	return best
}

// thermalThrottled infers throttling by comparing the current CPU frequency with
// the maximum. Home Assistant OS does not expose vcgencmd to add-ons, so the
// cpufreq interface is the portable signal available inside a container.
func thermalThrottled() (bool, float64) {
	cur := readIntFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
	max := readIntFile("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
	if cur == 0 || max == 0 {
		return false, 0
	}
	ratio := float64(cur) / float64(max)
	return ratio < 0.75, ratio
}

func readIntFile(path string) int64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	v, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// diskUsage returns total and free bytes for the filesystem holding path.
func diskUsage(path string) (total, free int64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	return int64(st.Blocks) * int64(st.Bsize), int64(st.Bavail) * int64(st.Bsize)
}

// processStats returns resident memory in bytes, cumulative CPU jiffies and the
// thread count for a pid, all from /proc.
func processStats(pid int) (rss int64, cpuJiffies float64, threads int) {
	if pid <= 0 {
		return 0, 0, 0
	}
	statRaw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, 0, 0
	}
	// The comm field may contain spaces and parentheses, so parsing starts after
	// the last closing parenthesis.
	line := string(statRaw)
	idx := strings.LastIndex(line, ")")
	if idx < 0 || idx+2 >= len(line) {
		return 0, 0, 0
	}
	fields := strings.Fields(line[idx+2:])
	// Counting from the state field: utime 11, stime 12, num_threads 17, rss 21.
	if len(fields) <= 21 {
		return 0, 0, 0
	}
	utime, _ := strconv.ParseFloat(fields[11], 64)
	stime, _ := strconv.ParseFloat(fields[12], 64)
	threads, _ = strconv.Atoi(fields[17])
	pages, _ := strconv.ParseInt(fields[21], 10, 64)
	return pages * int64(os.Getpagesize()), utime + stime, threads
}

// clockTicks is USER_HZ, which is 100 on every kernel Home Assistant OS ships.
func clockTicks() float64 { return 100 }

func cpuCount() int {
	raw, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return 1
	}
	count := strings.Count(string(raw), "processor")
	if count == 0 {
		return 1
	}
	return count
}
