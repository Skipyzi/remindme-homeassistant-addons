package flavours

import (
	"sync/atomic"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
)

// Switchable is an adapter.Backend that forwards to whichever flavour is active.
//
// Every manager is handed this one value at construction and keeps it for the
// life of the process, so switching flavours is a pointer swap rather than a
// rebuild of the whole controller. The swap only ever happens while Minecraft is
// stopped and the caller holds the supervisor lease, so no launch can observe a
// half-changed backend.
type Switchable struct {
	current atomic.Pointer[adapter.Backend]
}

// NewSwitchable starts on the given backend.
func NewSwitchable(initial adapter.Backend) *Switchable {
	s := &Switchable{}
	s.Set(initial)
	return s
}

// Set makes another backend active.
func (s *Switchable) Set(b adapter.Backend) { s.current.Store(&b) }

// Current is the active backend.
func (s *Switchable) Current() adapter.Backend { return *s.current.Load() }

func (s *Switchable) Name() string        { return s.Current().Name() }
func (s *Switchable) DisplayName() string { return s.Current().DisplayName() }
func (s *Switchable) JarName() string     { return s.Current().JarName() }

func (s *Switchable) Capabilities() adapter.Capabilities { return s.Current().Capabilities() }

func (s *Switchable) Argv(ctx adapter.LaunchContext) ([]string, error) {
	return s.Current().Argv(ctx)
}

func (s *Switchable) WorldArgs(dir string) []string { return s.Current().WorldArgs(dir) }

func (s *Switchable) FlagProfile(profile string, heapMB int) ([]string, error) {
	return s.Current().FlagProfile(profile, heapMB)
}

func (s *Switchable) Parse(line string) adapter.LogEvent { return s.Current().Parse(line) }

func (s *Switchable) StopCommand() string    { return s.Current().StopCommand() }
func (s *Switchable) SaveAllCommand() string { return s.Current().SaveAllCommand() }
func (s *Switchable) SaveOffCommand() string { return s.Current().SaveOffCommand() }
func (s *Switchable) SaveOnCommand() string  { return s.Current().SaveOnCommand() }

func (s *Switchable) GenerationCommands(a adapter.GenerationAction) []string {
	return s.Current().GenerationCommands(a)
}

func (s *Switchable) ConfigFiles() []adapter.ConfigFile    { return s.Current().ConfigFiles() }
func (s *Switchable) PropertiesFile() string               { return s.Current().PropertiesFile() }
func (s *Switchable) DefaultProperties() map[string]string { return s.Current().DefaultProperties() }
func (s *Switchable) EULAAcceptedContent() string          { return s.Current().EULAAcceptedContent() }
