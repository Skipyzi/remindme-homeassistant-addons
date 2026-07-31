package commands

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/flavours"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/worlds"
)

func newFlavourService(t *testing.T) (*Service, *testsupport.Env, *flavours.Switchable) {
	t.Helper()
	env := testsupport.NewEnv(t)
	backend := flavours.NewSwitchable(paper.New())
	sup := supervisor.New(supervisor.Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Backend: backend, Log: env.Log, Flags: backend.FlagProfile,
	})
	config := mcconfig.NewManager(env.Paths, backend, env.Store, env.Bus, env.Log)
	worldManager := worlds.NewManager(worlds.Deps{
		Paths: env.Paths, Settings: env.Settings, Store: env.Store, Bus: env.Bus,
		Supervisor: sup, Config: config, Log: env.Log, Backend: backend,
	})
	service := New(Deps{
		Paths: env.Paths, Backend: backend, ServerPort: 25565,
		Settings: env.Settings, Store: env.Store, Supervisor: sup,
		Config: config, Worlds: worldManager, Log: env.Log,
	})
	return service, env, backend
}

func TestSwitchFlavourNeedsTheFlavourNameAsConfirmation(t *testing.T) {
	service, env, backend := newFlavourService(t)

	_, err := service.SwitchFlavour("tester", "bta", "")
	var confirmErr ErrConfirmation
	if !errors.As(err, &confirmErr) {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
	if confirmErr.Expected != "bta" {
		t.Fatalf("unexpected phrase %q", confirmErr.Expected)
	}
	if backend.Name() != "paper" || env.Paths.Flavour() != "paper" {
		t.Fatal("nothing may change without the confirmation")
	}
}

func TestSwitchFlavourRepointsEverything(t *testing.T) {
	service, env, backend := newFlavourService(t)

	if _, err := env.Settings.Update(func(s *appcfg.Settings) {
		s.ActiveWorld = "survival"
		s.PaperVersion = "1.21.4"
	}); err != nil {
		t.Fatal(err)
	}
	paperWorlds := env.Paths.Worlds()

	status, err := service.SwitchFlavour("tester", "bta", "bta")
	if err != nil {
		t.Fatalf("switch: %v", err)
	}
	if status.Active != "bta" {
		t.Fatalf("expected bta to be active, got %q", status.Active)
	}
	if backend.Name() != "bta" {
		t.Fatalf("the backend did not follow the switch: %q", backend.Name())
	}
	if env.Paths.Worlds() == paperWorlds {
		t.Fatal("the world directory must differ per flavour")
	}
	if _, err := os.Stat(env.Paths.Worlds()); err != nil {
		t.Fatalf("the new flavour's directories were not created: %v", err)
	}

	// The properties file is the BTA one, seeded with BTA keys, and carries the
	// listen port because BTA has no launch argument for it.
	props, err := service.deps.Config.Properties()
	if err != nil {
		t.Fatal(err)
	}
	if got := props.GetOr("server-port", ""); got != "25565" {
		t.Fatalf("the listen port must be written into server.properties, got %q", got)
	}
	if _, ok := props.Get("allow-paradise"); !ok {
		t.Fatal("expected BTA defaults to be seeded")
	}
	if _, err := os.Stat(filepath.Join(env.Paths.Runtime(), "ops.txt")); err != nil {
		t.Fatalf("BTA's text list files should be created: %v", err)
	}

	// Switching back restores what Paper had.
	if _, err := service.SwitchFlavour("tester", "paper", "paper"); err != nil {
		t.Fatal(err)
	}
	settings := env.Settings.Get()
	if settings.ActiveWorld != "survival" || settings.PaperVersion != "1.21.4" {
		t.Fatalf("switching back lost the Paper state: %+v", settings)
	}
	if env.Paths.Worlds() != paperWorlds {
		t.Fatal("the world directory should be back to Paper's")
	}

	entries, err := env.Store.RecentAudit(10, "server.switch_flavour")
	if err != nil || len(entries) == 0 {
		t.Fatalf("expected an audit entry, got %d (%v)", len(entries), err)
	}
}

func TestSwitchFlavourRejectsAnUnknownName(t *testing.T) {
	service, _, _ := newFlavourService(t)
	if _, err := service.SwitchFlavour("tester", "forge", "forge"); err == nil {
		t.Fatal("expected an unknown flavour to be rejected")
	}
}

func TestFlavourStatusReportsWhatIsInstalled(t *testing.T) {
	service, env, _ := newFlavourService(t)
	env.WriteFakeJar()

	status := service.FlavourStatus()
	if status.Active != "paper" {
		t.Fatalf("unexpected active flavour %q", status.Active)
	}
	if len(status.Available) < 2 {
		t.Fatalf("expected more than one flavour, got %d", len(status.Available))
	}
	if status.Available[0].Name != "paper" {
		t.Fatalf("PaperMC should be listed first, got %q", status.Available[0].Name)
	}
	if !status.Installed["paper"] {
		t.Fatal("the installed Paper JAR should be reported")
	}
	if status.Installed["bta"] {
		t.Fatal("BTA is not installed in this fixture")
	}
	// The capabilities travel with the list so the UI can say what is missing.
	for _, info := range status.Available {
		if info.Name == "bta" && info.Caps.TerrainGeneration {
			t.Fatal("BTA has no terrain pre-generation")
		}
	}
}
