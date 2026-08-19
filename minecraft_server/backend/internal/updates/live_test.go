package updates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
)

// Opt-in probe against the real API; not part of the normal suite.
func TestLiveBTA(t *testing.T) {
	if os.Getenv("MC_LIVE_API") == "" {
		t.Skip("set MC_LIVE_API=1 to query the real API")
	}
	source := NewBTASource()
	versions, err := source.Versions(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("versions: %v", versions)
	builds, err := source.Builds(context.Background(), versions[0])
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("build: %+v", builds[0])
	data, err := httpDownload(context.Background(), builds[0].URL, source.DownloadHosts())
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	actual := hex.EncodeToString(sum[:])
	if builds[0].SHA256 == "" {
		// The CDN publishes no checksum; the installer computes and records one.
		t.Logf("downloaded %d bytes, computed sha256 %s", len(data), actual)
	} else if actual != builds[0].SHA256 {
		t.Fatalf("checksum mismatch: published %s, downloaded %s", builds[0].SHA256, actual)
	}
}

// Opt-in probe against the real Babric releases.
func TestLiveBabric(t *testing.T) {
	if os.Getenv("MC_LIVE_API") == "" {
		t.Skip("set MC_LIVE_API=1 to query the real API")
	}
	source := NewBabricSource()
	versions, err := source.Versions(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("versions: %v", versions)
	builds, err := source.Builds(context.Background(), versions[0])
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("build: %+v", builds[0])
}
