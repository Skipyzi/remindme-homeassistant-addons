package worlds

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/bta"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

// newLinkFixture builds a world manager on a backend that binds its world with a
// link rather than a launch argument, which is what a Beta-era server needs.
func newLinkFixture(t *testing.T) (*Manager, string) {
	t.Helper()
	env := testsupport.NewEnv(t)
	backend := bta.New()
	env.Paths.SetFlavour(backend.Name(), backend.JarName())
	if err := env.Paths.EnsureLayout(); err != nil {
		t.Fatal(err)
	}
	config := mcconfig.NewManager(env.Paths, backend, env.Store, env.Bus, env.Log)
	manager := NewManager(Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Config: config, Log: env.Log, Backend: backend,
	})
	return manager, env.Paths.Runtime()
}

// requireSymlinks skips on a Windows host without the privilege to create them.
// The add-on itself only ever runs on Linux.
func requireSymlinks(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	if err := os.Symlink(dir, filepath.Join(dir, "probe")); err != nil {
		t.Skipf("symlinks are not available here: %v", err)
	}
}

func TestLevelLinkPointsAtTheActiveWorld(t *testing.T) {
	requireSymlinks(t)
	manager, runtime := newLinkFixture(t)

	if err := manager.PrepareRuntime(); err != nil {
		t.Fatal(err)
	}
	active := manager.deps.Settings.Get().ActiveWorld
	if active == "" {
		t.Fatal("preparing the runtime should have picked an active world")
	}
	link := filepath.Join(runtime, "world")
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("the level link was not created: %v", err)
	}
	worldDir, err := manager.dir(active)
	if err != nil {
		t.Fatal(err)
	}
	if target != filepath.Join(worldDir, "world") {
		t.Fatalf("the link points at %q, want %q", target, filepath.Join(worldDir, "world"))
	}

	// A backend that binds with a link passes no world argument.
	if args := manager.ContainerArgs(); args != nil {
		t.Fatalf("expected no launch arguments, got %v", args)
	}
	// Preparing again is a no-op rather than an error.
	if err := manager.PrepareRuntime(); err != nil {
		t.Fatalf("re-preparing must be idempotent: %v", err)
	}
}

func TestLevelLinkFollowsAWorldSwitch(t *testing.T) {
	requireSymlinks(t)
	manager, runtime := newLinkFixture(t)
	if err := manager.PrepareRuntime(); err != nil {
		t.Fatal(err)
	}

	second, err := manager.Create(CreateRequest{Name: "beta"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.deps.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = second.ID }); err != nil {
		t.Fatal(err)
	}
	if err := manager.PrepareRuntime(); err != nil {
		t.Fatal(err)
	}

	target, err := os.Readlink(filepath.Join(runtime, "world"))
	if err != nil {
		t.Fatal(err)
	}
	worldDir, _ := manager.dir(second.ID)
	if target != filepath.Join(worldDir, "world") {
		t.Fatalf("the link did not follow the switch: %q", target)
	}
}

// A real directory where the link belongs is somebody's world. Replacing it
// would delete data, so it is refused instead.
func TestLevelLinkRefusesToReplaceARealWorldDirectory(t *testing.T) {
	requireSymlinks(t)
	manager, runtime := newLinkFixture(t)

	intruder := filepath.Join(runtime, "world")
	if err := os.MkdirAll(intruder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(intruder, "level.dat"), []byte("nbt"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := manager.PrepareRuntime()
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if _, statErr := os.Stat(filepath.Join(intruder, "level.dat")); statErr != nil {
		t.Fatalf("the existing world data was touched: %v", statErr)
	}
}

func TestPaperUsesALaunchArgumentInsteadOfALink(t *testing.T) {
	fixture := newFixture(t)
	if err := fixture.manager.PrepareRuntime(); err != nil {
		t.Fatal(err)
	}
	args := fixture.manager.ContainerArgs()
	if len(args) != 2 || args[0] != "--world-container" {
		t.Fatalf("expected a world container argument, got %v", args)
	}
	if _, err := os.Lstat(filepath.Join(fixture.env.Paths.Runtime(), "world")); err == nil {
		t.Fatal("Paper must not get a level link")
	}
	if binding := fixture.manager.binding(); binding != adapter.BindContainerArg {
		t.Fatalf("unexpected binding %q", binding)
	}
}
