package paper

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

// writeJar builds a minimal JAR containing the given version.json body.
func writeJar(t *testing.T, versionJSON string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "paper.jar")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	zw := zip.NewWriter(file)
	if versionJSON != "" {
		w, err := zw.Create("version.json")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(versionJSON)); err != nil {
			t.Fatal(err)
		}
	}
	other, err := zw.Create("META-INF/MANIFEST.MF")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.Write([]byte("Main-Class: io.papermc.paperclip.Main\n")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInspectJarReadsTheRequiredJavaVersion(t *testing.T) {
	// Captured from a real paper-26.2 build: this is the case that broke a
	// Java-21-only image.
	path := writeJar(t, `{"id":"26.2","name":"26.2","world_version":4903,
		"java_component":"java-runtime-epsilon","java_version":25,"stable":true}`)

	info, err := InspectJar(path)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if info.RequiredJava != 25 {
		t.Fatalf("expected Java 25, got %d", info.RequiredJava)
	}
	if info.MinecraftVersion != "26.2" {
		t.Fatalf("expected the Minecraft version, got %q", info.MinecraftVersion)
	}
	if !info.Declared {
		t.Fatal("expected the requirement to be reported as declared")
	}
}

func TestInspectJarHandlesThe121Line(t *testing.T) {
	path := writeJar(t, `{"id":"1.21.4","name":"1.21.4","java_version":21,"stable":true}`)
	info, err := InspectJar(path)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if info.RequiredJava != 21 || info.MinecraftVersion != "1.21.4" {
		t.Fatalf("unexpected info %+v", info)
	}
}

func TestInspectJarFallsBackWhenTheManifestIsMissing(t *testing.T) {
	path := writeJar(t, "")
	info, err := InspectJar(path)
	if err != nil {
		t.Fatalf("a JAR without version.json should not be an error: %v", err)
	}
	if info.RequiredJava != DefaultRequiredJava {
		t.Fatalf("expected the conservative default, got %d", info.RequiredJava)
	}
	if info.Declared {
		t.Fatal("a fallback must not be reported as declared")
	}
}

func TestInspectJarRejectsSomethingThatIsNotAJar(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not.jar")
	if err := os.WriteFile(path, []byte("<html>404</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectJar(path); err == nil {
		t.Fatal("expected an error for a non-JAR file")
	}
}

func TestInspectJarToleratesAnOddManifest(t *testing.T) {
	// A build that omits java_version keeps the default rather than reporting 0,
	// which would otherwise disable the launch check entirely.
	path := writeJar(t, `{"id":"1.20.6","name":"1.20.6"}`)
	info, err := InspectJar(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.RequiredJava != DefaultRequiredJava || info.Declared {
		t.Fatalf("unexpected info %+v", info)
	}
	if info.MinecraftVersion != "1.20.6" {
		t.Fatalf("expected the version to still be read, got %q", info.MinecraftVersion)
	}
}
