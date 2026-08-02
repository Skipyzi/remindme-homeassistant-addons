package javaruntime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelectPicksTheLowestRuntimeThatSatisfies(t *testing.T) {
	runtimes := []Runtime{
		{Major: 21, Path: "/usr/lib/jvm/java-21-openjdk/bin/java"},
		{Major: 25, Path: "/usr/lib/jvm/java-25-openjdk/bin/java"},
	}

	// A 1.21 server should stay on the JVM Paper tests it against.
	chosen, err := Select(runtimes, 21)
	if err != nil || chosen.Major != 21 {
		t.Fatalf("expected Java 21, got %+v (%v)", chosen, err)
	}
	// Minecraft 26.x declares 25.
	chosen, err = Select(runtimes, 25)
	if err != nil || chosen.Major != 25 {
		t.Fatalf("expected Java 25, got %+v (%v)", chosen, err)
	}
	// An unknown requirement falls back to the documented minimum.
	chosen, err = Select(runtimes, 0)
	if err != nil || chosen.Major != 21 {
		t.Fatalf("expected the default to resolve to Java 21, got %+v (%v)", chosen, err)
	}
}

func TestSelectExplainsAMissingRuntime(t *testing.T) {
	runtimes := []Runtime{{Major: 21, Path: "/usr/lib/jvm/java-21-openjdk/bin/java"}}
	_, err := Select(runtimes, 25)
	if err == nil {
		t.Fatal("expected an error when no runtime satisfies the requirement")
	}
	// The message has to name both numbers: it is what the operator sees instead of
	// UnsupportedClassVersionError.
	if !strings.Contains(err.Error(), "Java 25") || !strings.Contains(err.Error(), "21") {
		t.Fatalf("unhelpful error: %v", err)
	}

	if _, err := Select(nil, 21); err == nil {
		t.Fatal("expected an error when no runtime is installed at all")
	}
}

func TestDiscoverHonoursTheExplicitOverride(t *testing.T) {
	dir := t.TempDir()
	fake21 := filepath.Join(dir, "java21")
	fake25 := filepath.Join(dir, "java25")
	for _, path := range []string{fake21, fake25} {
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("MC_JAVA_RUNTIMES", "25="+fake25+string(os.PathListSeparator)+"21="+fake21)

	runtimes := Discover()
	if len(runtimes) != 2 {
		t.Fatalf("expected two runtimes, got %+v", runtimes)
	}
	// Sorted ascending so Select can take the first match.
	if runtimes[0].Major != 21 || runtimes[1].Major != 25 {
		t.Fatalf("runtimes are not sorted by feature release: %+v", runtimes)
	}
	if runtimes[0].Path != fake21 {
		t.Fatalf("unexpected path %q", runtimes[0].Path)
	}
}

func TestMajorFromPath(t *testing.T) {
	if got := majorFromPath.FindStringSubmatch("/usr/lib/jvm/java-25-openjdk/bin/java"); len(got) != 2 || got[1] != "25" {
		t.Fatalf("failed to read the version from the path: %v", got)
	}
	if got := majorFromPath.FindStringSubmatch("/usr/lib/jvm/java-21-openjdk/jre/bin/java"); len(got) != 2 || got[1] != "21" {
		t.Fatalf("failed to read the version from the path: %v", got)
	}
}

func TestDescribe(t *testing.T) {
	if got := Describe(nil); got != "none" {
		t.Fatalf("got %q", got)
	}
	got := Describe([]Runtime{{Major: 21}, {Major: 25}})
	if got != "Java 21, Java 25" {
		t.Fatalf("got %q", got)
	}
}
