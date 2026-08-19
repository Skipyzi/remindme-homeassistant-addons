package appcfg

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Options mirrors the add-on options schema in config.yaml. Options are the
// bootstrap defaults: on first start they seed Settings, which the web UI then
// owns so that day-to-day changes do not require an add-on restart.
type Options struct {
	ServerPort      int    `json:"server_port"`
	MemoryMinMB     int    `json:"memory_min_mb"`
	MemoryMaxMB     int    `json:"memory_max_mb"`
	JVMFlagsProfile string `json:"jvm_flags_profile"`
	JVMFlagsCustom  string `json:"jvm_flags_custom"`
	// Flavour seeds the server flavour on first start. Afterwards the web UI owns
	// it, because switching is a stateful operation and not a restart-time one.
	Flavour      string `json:"server_flavour"`
	PaperVersion string `json:"paper_version"`
	// RunServerAsRoot keeps the Minecraft process running as root. Add-on
	// containers are root, and Minecraft warns about it on every start; the
	// controller drops the server to an unprivileged user unless this is set.
	RunServerAsRoot     bool   `json:"run_server_as_root"`
	AutoRestartOnCrash  bool   `json:"auto_restart_on_crash"`
	StopTimeoutSeconds  int    `json:"stop_timeout_seconds"`
	MQTTEnabled         bool   `json:"mqtt_enabled"`
	MQTTHost            string `json:"mqtt_host"`
	MQTTPort            int    `json:"mqtt_port"`
	MQTTUsername        string `json:"mqtt_username"`
	MQTTPassword        string `json:"mqtt_password"`
	MQTTDiscoveryPrefix string `json:"mqtt_discovery_prefix"`
	ChunkySource        string `json:"chunky_source"`
	ChunkyDownloadURL   string `json:"chunky_download_url"`
	ChunkySHA256        string `json:"chunky_sha256"`
	AllowDirectAccess   bool   `json:"allow_direct_access"`
	LogLevel            string `json:"log_level"`
}

// Environment describes everything the controller learns from its environment
// rather than from a user: paths, the listen address and Supervisor services.
type Environment struct {
	Paths       Paths
	Listen      string
	FrontendDir string
	AssetsDir   string
	LogLevel    string
	// SupervisorToken enables Supervisor API calls (mqtt service discovery).
	SupervisorToken string
	// MQTT connection details published by the Supervisor mqtt service.
	MQTTService MQTTService
}

type MQTTService struct {
	Host     string
	Port     int
	Username string
	Password string
}

func (m MQTTService) Available() bool { return m.Host != "" }

func DefaultOptions() Options {
	return Options{
		ServerPort:          25565,
		MemoryMinMB:         1024,
		MemoryMaxMB:         3072,
		JVMFlagsProfile:     "balanced",
		StopTimeoutSeconds:  120,
		MQTTEnabled:         true,
		MQTTPort:            1883,
		MQTTDiscoveryPrefix: "homeassistant",
		ChunkySource:        "modrinth",
		Flavour:             DefaultFlavour,
		LogLevel:            "info",
	}
}

// LoadOptions reads /data/options.json. A missing file is not an error: it means
// the controller runs outside the Supervisor (local development).
func LoadOptions(path string) (Options, error) {
	opts := DefaultOptions()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return opts, nil
		}
		return opts, err
	}
	if err := json.Unmarshal(raw, &opts); err != nil {
		return opts, fmt.Errorf("parse %s: %w", path, err)
	}
	return opts, opts.Validate()
}

func (o Options) Validate() error {
	if o.ServerPort < 1 || o.ServerPort > 65535 {
		return fmt.Errorf("server_port %d out of range", o.ServerPort)
	}
	if o.MemoryMaxMB < o.MemoryMinMB {
		return fmt.Errorf("memory_max_mb (%d) is below memory_min_mb (%d)", o.MemoryMaxMB, o.MemoryMinMB)
	}
	if o.JVMFlagsProfile == "custom" {
		if _, err := ValidateJavaFlags(o.JVMFlagsCustom); err != nil {
			return err
		}
	}
	switch o.Flavour {
	case "", DefaultFlavour, "bta", "babric":
	default:
		return fmt.Errorf("unknown server_flavour %q", o.Flavour)
	}
	switch o.ChunkySource {
	case "modrinth", "manual":
	case "url":
		if o.ChunkyDownloadURL == "" || o.ChunkySHA256 == "" {
			return fmt.Errorf("chunky_source=url requires chunky_download_url and chunky_sha256")
		}
	default:
		return fmt.Errorf("unknown chunky_source %q", o.ChunkySource)
	}
	return nil
}

// LoadEnvironment collects the process environment. Defaults are development
// friendly: ./devdata when MC_DATA_DIR is unset.
func LoadEnvironment() Environment {
	data := envOr("MC_DATA_DIR", "devdata")
	env := Environment{
		Paths:           NewPaths(data),
		Listen:          envOr("MC_LISTEN", "127.0.0.1:8099"),
		FrontendDir:     envOr("MC_FRONTEND_DIR", "../frontend"),
		AssetsDir:       envOr("MC_ASSETS_DIR", "../"),
		LogLevel:        envOr("MC_LOG_LEVEL", "info"),
		SupervisorToken: os.Getenv("SUPERVISOR_TOKEN"),
	}
	env.MQTTService = MQTTService{
		Host:     os.Getenv("MC_MQTT_SERVICE_HOST"),
		Port:     envInt("MC_MQTT_SERVICE_PORT", 1883),
		Username: os.Getenv("MC_MQTT_SERVICE_USERNAME"),
		Password: os.Getenv("MC_MQTT_SERVICE_PASSWORD"),
	}
	return env
}

// OptionsFile returns the options path, overridable for tests.
func OptionsFile() string { return envOr("MC_OPTIONS_FILE", "/data/options.json") }

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key))); err == nil {
		return v
	}
	return fallback
}

// ValidateJavaFlags splits a flag string into an argv slice and rejects anything
// that is not a plain JVM flag. Nothing here ever reaches a shell, but a stray
// quote or semicolon almost always means the user made a mistake, and rejecting
// it early beats a Java process that refuses to boot.
func ValidateJavaFlags(s string) ([]string, error) {
	fields := strings.Fields(s)
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if !strings.HasPrefix(f, "-") {
			return nil, fmt.Errorf("java flag %q does not start with '-'", f)
		}
		if strings.ContainsAny(f, ";|&$`\n\r\t\"'<>(){}*?") {
			return nil, fmt.Errorf("java flag %q contains unsupported characters", f)
		}
		if strings.HasPrefix(f, "-Xmx") || strings.HasPrefix(f, "-Xms") {
			return nil, fmt.Errorf("heap flag %q is managed by the add-on, set it in the memory settings", f)
		}
		if strings.HasPrefix(f, "-jar") || strings.HasPrefix(f, "-cp") || strings.HasPrefix(f, "-classpath") {
			return nil, fmt.Errorf("flag %q is not allowed", f)
		}
		out = append(out, f)
	}
	return out, nil
}
