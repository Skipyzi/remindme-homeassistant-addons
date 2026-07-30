// Command fakepaper emulates just enough of a PaperMC server for the controller
// tests: the console grammar the supervisor parses, and the commands it sends.
//
// Behaviour is selected with FAKEPAPER_MODE:
//
//	ready        start normally and obey stop (default)
//	crash_start  print an error and exit 1 immediately
//	no_ready     start but never print the "Done" line
//	ignore_stop  print the ready line but ignore the stop command
//	crash_late   exit with code 137 a moment after becoming ready
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"
)

func main() {
	mode := os.Getenv("FAKEPAPER_MODE")
	if mode == "" {
		mode = "ready"
	}
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	say := func(format string, args ...any) {
		fmt.Fprintf(out, "[%s INFO]: %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
		out.Flush()
	}

	say("Starting minecraft server version 1.21.4")
	say("This server is running Paper version 1.21.4-100-main@abcdef (MC: 1.21.4)")

	if mode == "crash_start" {
		fmt.Fprintln(os.Stderr, "[ERROR]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.")
		os.Exit(1)
	}
	if mode != "no_ready" {
		say(`Done (1.234s)! For help, type "help"`)
	}
	if mode == "crash_late" {
		time.Sleep(300 * time.Millisecond)
		fmt.Fprintln(os.Stderr, "java.lang.OutOfMemoryError: Java heap space")
		os.Exit(137)
	}

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		command := strings.TrimSpace(scanner.Text())
		switch {
		case command == "stop":
			if mode == "ignore_stop" {
				say("ignoring stop as instructed")
				continue
			}
			say("Stopping the server")
			out.Flush()
			os.Exit(0)
		case strings.HasPrefix(command, "save-all"):
			say("Saved the game")
		case command == "save-off":
			say("Automatic saving is now disabled")
		case command == "save-on":
			say("Automatic saving is now enabled")
		case command == "list":
			say("There are 0 of a max of 10 players online:")
		case strings.HasPrefix(command, "chunky "):
			handleChunky(say, strings.TrimPrefix(command, "chunky "))
		case command == "join-player":
			// Test hook: pretend somebody joined.
			say("Alex joined the game")
		case command == "leave-player":
			say("Alex left the game")
		default:
			say("Unknown command or unhandled: %s", command)
		}
	}
	// stdin closed: behave like a server whose console went away.
	say("Stopping the server")
}

func handleChunky(say func(string, ...any), args string) {
	switch {
	case strings.HasPrefix(args, "start"):
		say("[Chunky] [world] Task started for world")
		go func() {
			for _, percent := range []float64{12.5, 55.0, 99.0} {
				time.Sleep(120 * time.Millisecond)
				say("[Chunky] [world] Task running: %d/%d chunks (%.2f%%), 42.5 cps, ETA: 00:01:30",
					int(percent*10), 1000, percent)
			}
			time.Sleep(120 * time.Millisecond)
			say("[Chunky] [world] Task finished for world")
		}()
	case strings.HasPrefix(args, "pause"):
		say("[Chunky] [world] Task paused")
	case strings.HasPrefix(args, "continue"):
		say("[Chunky] [world] Task running: 550/1000 chunks (55.00%%), 40.0 cps, ETA: 00:01:00")
	case strings.HasPrefix(args, "cancel"):
		say("[Chunky] [world] Task cancelled")
	default:
		say("[Chunky] %s", args)
	}
}
