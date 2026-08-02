// Package adapter isolates everything server-flavour specific: how the process
// is launched, what its console output means and which configuration files it
// owns. PaperMC and Better than Adventure! are implemented today; another
// flavour is a Backend implementation plus an entry in the flavours registry,
// with no change to the managers above it.
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

// WorldBinding is how a backend is told which world set to open.
type WorldBinding string

const (
	// BindContainerArg passes the world set directory as a launch argument, which
	// is what Paper's --world-container does. Switching is a change of arguments:
	// no data moves and there is no half-switched state.
	BindContainerArg WorldBinding = "container_arg"
	// BindLevelLink is for servers that only ever look next to their working
	// directory (Beta-era servers do). The controller points a link in the working
	// directory at the active world set instead. Still no data movement, but the
	// link has to be rewritten on every switch.
	BindLevelLink WorldBinding = "level_link"
)

// Capabilities says which of the controller's features apply to a flavour. They
// are not preferences: a false here means the feature cannot work, and the UI
// hides it rather than offering something that will fail.
type Capabilities struct {
	// BukkitPlugins is true when the server loads Bukkit/Spigot plugins from a
	// plugins directory. The bridge plugin and Chunky both need this.
	BukkitPlugins bool `json:"bukkit_plugins"`
	// BridgeTelemetry is true when the management plugin can report TPS, MSPT and
	// heap use. Without it those come from log parsing only.
	BridgeTelemetry bool `json:"bridge_telemetry"`
	// TerrainGeneration is true when a pre-generation plugin exists for the
	// flavour.
	TerrainGeneration bool `json:"terrain_generation"`
	// EULAFile is true when the server refuses to run until an eula.txt exists.
	EULAFile bool `json:"eula_file"`
	// ServerPortArg is true when the listen port is a launch argument. When false
	// the port has to be written into the properties file instead.
	ServerPortArg bool `json:"server_port_arg"`
	// WorldBinding is how the active world set is selected.
	WorldBinding WorldBinding `json:"world_binding"`
	// Dimensions are the sub-directories of a world set, in backup and size
	// reporting order. The first entry is the one that must exist for a world to
	// be usable.
	Dimensions []string `json:"dimensions"`
	// Notes are shown in the UI to explain what this flavour does differently.
	Notes []string `json:"notes,omitempty"`
}

// Backend is the server-flavour contract.
type Backend interface {
	// Name is the stable identifier ("paper").
	Name() string
	DisplayName() string

	// Capabilities reports which controller features apply.
	Capabilities() Capabilities

	// JarName is the file name the installed server JAR is stored under, inside
	// the flavour's runtime directory.
	JarName() string

	// Argv builds the launch command. It must never invoke a shell.
	Argv(ctx LaunchContext) ([]string, error)

	// WorldArgs returns the launch arguments that point the server at a world set
	// directory. Backends that bind worlds another way return nil.
	WorldArgs(dir string) []string

	// FlagProfile resolves a JVM flag profile name into flags.
	FlagProfile(profile string, heapMB int) ([]string, error)

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
