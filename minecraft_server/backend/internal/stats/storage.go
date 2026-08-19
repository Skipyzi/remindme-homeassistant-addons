package stats

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// deviceFor finds the source device of the longest mount point that prefixes
// path. Overlay and other virtual filesystems return their name, which
// classifies as unknown - true inside a development container, where the
// answer honestly is unknown.
func deviceFor(path, mountsFile string) string {
	raw, err := os.ReadFile(mountsFile)
	if err != nil {
		return ""
	}
	best := ""
	bestLen := -1
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		mount := fields[1]
		if (path == mount || strings.HasPrefix(path, mount+"/") || mount == "/") && len(mount) > bestLen {
			best = fields[0]
			bestLen = len(mount)
		}
	}
	return best
}

var partitionSuffix = regexp.MustCompile(`p?[0-9]+$`)

// classifyDevice maps a /dev node onto the words an operator needs.
func classifyDevice(device, sysBlock string) string {
	name := strings.TrimPrefix(device, "/dev/")
	if name == "" || strings.Contains(name, "/") || !strings.HasPrefix(device, "/dev/") {
		return ""
	}
	switch {
	case strings.HasPrefix(name, "mmcblk"):
		return "sd-card"
	case strings.HasPrefix(name, "nvme"):
		return "nvme"
	}
	// sda1 -> sda; rotational says HDD or SSD.
	base := partitionSuffix.ReplaceAllString(name, "")
	if raw, err := os.ReadFile(filepath.Join(sysBlock, base, "queue", "rotational")); err == nil {
		if strings.TrimSpace(string(raw)) == "1" {
			return "hdd"
		}
		return "ssd"
	}
	return ""
}
