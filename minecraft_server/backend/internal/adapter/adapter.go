// Package adapter isolates everything server-flavour specific: how the process
// is launched, what its console output means and which configuration files it
// owns. PaperMC is the only implementation today; PumpkinMC or Fabric can be
// added by implementing Backend without touching the managers above it.
package adapter

// LogKind classifies a console line.
type LogKind string

const (
	KindOther            LogKind = "other"
	KindReady            LogKind = "ready"
	KindStopping         LogKind = "stopping"
	KindVersion          LogKind = "version"
	KindPlayerJoin       LogKind = "player_join"
	KindPlayerLeave      LogKind = "player_leave"
	KindEULARequired     LogKind = "eula_required"
	KindSaved            LogKind = "saved"
	KindSaveDisabled     LogKind = "save_disabled"
	KindSaveEnabled      LogKind = "save_enabled"
	KindPortUnavailable  LogKind = "port_unavailable"
	KindOutOfMemory      LogKind = "out_of_memory"
	KindPluginIncompat   LogKind = "plugin_incompatible"
	KindWorldCorrupt     LogKind = "world_corrupt"
	KindGenProgress      LogKind = "generation_progress"
	KindGenTaskDone      LogKind = "generation_task_done"
	KindGenTaskStarted   LogKind = "generation_task_started"
	KindGenTaskCancelled LogKind = "generation_task_cancelled"
	KindGenNotInstalled  LogKind = "generation_not_installed"
)

// LogEvent is the structured meaning of one console line.
type LogEvent struct {
	Kind        LogKind
	Player      string
	Version     string
	Build       string
	Percent     float64
	ChunksDone  int64
	ChunksTotal int64
	Rate        float64
	ETASeconds  int64
	World       string
	Message     string
}

// LaunchContext is everything needed to build an argv. The supervisor fills it
// in from settings so the adapter never reads configuration itself.
type LaunchContext struct {
	JavaBin    string
	JarPath    string
	WorkDir    string
	HeapMinMB  int
	HeapMaxMB  int
	Flags      []string
	ServerPort int
	// Nogui keeps Paper from trying to open a Swing window.
	Nogui bool
}

// ConfigFile describes an editable configuration file relative to the server
// working directory. Only files listed by the backend may be read or written.
type ConfigFile struct {
	Name            string `json:"name"`
	RelPath         string `json:"rel_path"`
	Format          string `json:"format"` // properties | yaml | json
	Description     string `json:"description"`
	RestartRequired bool   `json:"restart_required"`
	CreateIfMissing bool   `json:"create_if_missing"`
}

// Backend is the server-flavour contract.
type Backend interface {
	// Name is the stable identifier ("paper").
	Name() string
	DisplayName() string

	// Argv builds the launch command. It must never invoke a shell.
	Argv(ctx LaunchContext) ([]string, error)

	// Parse turns one console line into a structured event.
	Parse(line string) LogEvent

	// Console commands.
	StopCommand() string
	SaveAllCommand() string
	SaveOffCommand() string
	SaveOnCommand() string
	// GenerationCommands returns the console commands that drive the terrain
	// pre-generation plugin for the given action.
	GenerationCommands(action GenerationAction) []string

	// ConfigFiles lists editable files.
	ConfigFiles() []ConfigFile
	// PropertiesFile is the main key/value settings file ("server.properties").
	PropertiesFile() string
	// DefaultProperties seeds a fresh installation.
	DefaultProperties() map[string]string
	// EULAAcceptedContent is the exact file content that records acceptance.
	EULAAcceptedContent() string
}

// GenerationAction is a terrain-generation verb. The concrete console commands
// are backend specific because the plugin may differ per flavour.
type GenerationAction struct {
	Verb      string // configure | start | pause | resume | cancel | progress | quiet
	World     string
	Shape     string
	Radius    int
	CenterX   int
	CenterZ   int
	Dimension string
	Silent    bool
}
