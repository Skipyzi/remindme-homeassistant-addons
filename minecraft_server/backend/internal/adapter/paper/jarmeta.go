package paper

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
)

// DefaultRequiredJava is assumed when a JAR does not declare what it needs.
// Every Paper build for Minecraft 1.20.5 and newer needs at least this.
const DefaultRequiredJava = 21

// versionManifest is the part of Minecraft's own version.json the add-on reads.
// Paper ships it inside the JAR, and since the 1.21.9 era it states the required
// Java feature release: Minecraft 26.x asks for Java 25, while the 1.21 line asks
// for 21. Reading it is how the controller avoids launching a server against a
// JVM that will only answer with UnsupportedClassVersionError.
type versionManifest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	JavaVersion int    `json:"java_version"`
	Stable      bool   `json:"stable"`
}

// JarInfo is what can be learned from a server JAR without running it.
type JarInfo struct {
	MinecraftVersion string `json:"minecraft_version"`
	RequiredJava     int    `json:"required_java"`
	Declared         bool   `json:"declared"`
}

// InspectJar reads version.json out of a Paper JAR.
//
// A JAR that does not contain it (a very old build, or something that is not a
// Paper JAR at all) reports the conservative default rather than failing: the
// launch itself is still guarded, and refusing to start over a missing metadata
// file would be worse than trying.
func InspectJar(path string) (JarInfo, error) {
	info := JarInfo{RequiredJava: DefaultRequiredJava}

	reader, err := zip.OpenReader(path)
	if err != nil {
		return info, fmt.Errorf("read server JAR: %w", err)
	}
	defer reader.Close()

	for _, entry := range reader.File {
		if entry.Name != "version.json" {
			continue
		}
		rc, err := entry.Open()
		if err != nil {
			return info, err
		}
		defer rc.Close()
		// The manifest is a couple of hundred bytes; the limit is paranoia about
		// a hostile archive rather than a real expectation.
		raw, err := io.ReadAll(io.LimitReader(rc, 64<<10))
		if err != nil {
			return info, err
		}
		var manifest versionManifest
		if err := json.Unmarshal(raw, &manifest); err != nil {
			return info, fmt.Errorf("parse version.json: %w", err)
		}
		info.MinecraftVersion = manifest.ID
		if manifest.JavaVersion > 0 {
			info.RequiredJava = manifest.JavaVersion
			info.Declared = true
		}
		return info, nil
	}
	return info, nil
}
