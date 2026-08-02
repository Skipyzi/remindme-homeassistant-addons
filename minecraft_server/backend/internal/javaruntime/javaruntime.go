// Package javaruntime finds the JVMs installed in the container and picks the one
// a given server JAR needs.
//
// The image bundles more than one JRE on purpose: Minecraft 1.21 needs Java 21
// while the 26.x releases need Java 25, and an add-on that shipped only one of
// them would either refuse new Minecraft versions or drop support for existing
// worlds on the older one.
package javaruntime

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Runtime is one installed JVM.
type Runtime struct {
	Major int    `json:"major"`
	Path  string `json:"path"`
	Home  string `json:"home"`
}

// searchGlobs cover the Alpine layout used by the add-on image plus the usual
// Debian one, so a locally built variant of the image still works.
var searchGlobs = []string{
	"/usr/lib/jvm/java-*-openjdk/bin/java",
	"/usr/lib/jvm/*/bin/java",
	"/opt/java/*/bin/java",
}

var majorFromPath = regexp.MustCompile(`java-(\d+)-`)

// Discover returns the JVMs found on this system, lowest feature release first.
//
// MC_JAVA_RUNTIMES overrides discovery with an explicit list, either
// "21=/path/to/java" pairs or plain paths whose version is then queried. That is
// what makes this testable and what lets an unusual installation point the add-on
// at its own JVMs.
func Discover() []Runtime {
	if explicit := os.Getenv("MC_JAVA_RUNTIMES"); explicit != "" {
		return sortRuntimes(parseExplicit(explicit))
	}

	seen := map[string]bool{}
	var found []Runtime
	for _, pattern := range searchGlobs {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		for _, path := range matches {
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil {
				resolved = path
			}
			if seen[resolved] {
				continue
			}
			seen[resolved] = true
			major := majorFor(path)
			if major == 0 {
				continue
			}
			found = append(found, Runtime{Major: major, Path: path, Home: filepath.Dir(filepath.Dir(path))})
		}
	}
	if len(found) == 0 {
		// Fall back to whatever "java" is on PATH; a development machine usually
		// has exactly one.
		if path, err := exec.LookPath("java"); err == nil {
			if major := queryMajor(path); major > 0 {
				found = append(found, Runtime{Major: major, Path: path, Home: filepath.Dir(filepath.Dir(path))})
			}
		}
	}
	return sortRuntimes(found)
}

func parseExplicit(value string) []Runtime {
	var out []Runtime
	for _, item := range strings.Split(value, string(os.PathListSeparator)) {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if major, path, ok := strings.Cut(item, "="); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(major)); err == nil {
				out = append(out, Runtime{Major: n, Path: path, Home: filepath.Dir(filepath.Dir(path))})
				continue
			}
		}
		if major := majorFor(item); major > 0 {
			out = append(out, Runtime{Major: major, Path: item, Home: filepath.Dir(filepath.Dir(item))})
		}
	}
	return out
}

func sortRuntimes(runtimes []Runtime) []Runtime {
	sort.Slice(runtimes, func(i, j int) bool { return runtimes[i].Major < runtimes[j].Major })
	return runtimes
}

// majorFor prefers the version in the path (no subprocess) and only asks the JVM
// itself when the path says nothing.
func majorFor(path string) int {
	if m := majorFromPath.FindStringSubmatch(path); len(m) == 2 {
		if n, err := strconv.Atoi(m[1]); err == nil {
			return n
		}
	}
	return queryMajor(path)
}

var versionLine = regexp.MustCompile(`version "?(\d+)`)

func queryMajor(path string) int {
	cmd := exec.Command(path, "-version") // #nosec G204 - path comes from a glob or an explicit setting
	output, err := cmd.CombinedOutput()
	if err != nil && len(output) == 0 {
		return 0
	}
	if m := versionLine.FindStringSubmatch(string(output)); len(m) == 2 {
		if n, err := strconv.Atoi(m[1]); err == nil {
			return n
		}
	}
	return 0
}

// Select picks the JVM for a JAR that needs at least requiredMajor.
//
// The lowest runtime that satisfies the requirement wins: running a 1.21 server on
// Java 21 rather than 25 keeps it on the JVM Paper tests against for that version.
func Select(runtimes []Runtime, requiredMajor int) (Runtime, error) {
	if requiredMajor <= 0 {
		requiredMajor = 21
	}
	if len(runtimes) == 0 {
		return Runtime{}, fmt.Errorf("no Java runtime found in this container")
	}
	for _, runtime := range runtimes {
		if runtime.Major >= requiredMajor {
			return runtime, nil
		}
	}
	available := make([]string, 0, len(runtimes))
	for _, runtime := range runtimes {
		available = append(available, strconv.Itoa(runtime.Major))
	}
	return Runtime{}, fmt.Errorf(
		"this server needs Java %d but only Java %s is installed; install a Paper build for an older Minecraft version or update the add-on",
		requiredMajor, strings.Join(available, ", "))
}

// Describe renders the installed runtimes for the UI and the logs.
func Describe(runtimes []Runtime) string {
	if len(runtimes) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(runtimes))
	for _, runtime := range runtimes {
		parts = append(parts, "Java "+strconv.Itoa(runtime.Major))
	}
	return strings.Join(parts, ", ")
}
