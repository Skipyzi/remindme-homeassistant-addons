// Package events is the controller's in-process event bus. The REST layer turns
// it into a Server-Sent Events stream; the MQTT layer turns parts of it into
// Home Assistant state updates.
package events

import (
	"sync"
	"sync/atomic"
	"time"
)

// Event types. These are the strings clients see on the wire.
const (
	TypeServerState        = "server_state"
	TypeServerLog          = "server_log"
	TypeStatsUpdate        = "stats_update"
	TypePlayerJoin         = "player_join"
	TypePlayerLeave        = "player_leave"
	TypeBackupProgress     = "backup_progress"
	TypeRestoreProgress    = "restore_progress"
	TypeGenerationProgress = "generation_progress"
	TypeGenerationPaused   = "generation_paused"
	TypeGenerationResumed  = "generation_resumed"
	TypeGenerationDone     = "generation_completed"
	TypeWorldsChanged      = "worlds_changed"
	TypeBackupsChanged     = "backups_changed"
	TypeConfigChanged      = "config_changed"
	TypeSettingsChanged    = "settings_changed"
	TypeTaskProgress       = "task_progress"
	TypeWarning            = "warning"
	TypeError              = "error"
)

type Event struct {
	Seq  uint64 `json:"seq"`
	Type string `json:"type"`
	Time string `json:"time"`
	Data any    `json:"data,omitempty"`
}

type subscriber struct {
	ch      chan Event
	dropped atomic.Int64
}

// Bus fans events out to subscribers. Publishing never blocks: a subscriber that
// cannot keep up loses events and is told how many, which is the right trade-off
// for a dashboard.
type Bus struct {
	mu     sync.RWMutex
	subs   map[int]*subscriber
	nextID int
	seq    atomic.Uint64
	now    func() time.Time
}

func NewBus() *Bus {
	return &Bus{subs: make(map[int]*subscriber), now: time.Now}
}

// Subscribe returns a channel of events and a cancel function. buffer sets how
// many events may queue for this subscriber before events are dropped.
func (b *Bus) Subscribe(buffer int) (<-chan Event, func()) {
	if buffer <= 0 {
		buffer = 64
	}
	s := &subscriber{ch: make(chan Event, buffer)}
	b.mu.Lock()
	id := b.nextID
	b.nextID++
	b.subs[id] = s
	b.mu.Unlock()

	return s.ch, func() {
		b.mu.Lock()
		if cur, ok := b.subs[id]; ok {
			delete(b.subs, id)
			close(cur.ch)
		}
		b.mu.Unlock()
	}
}

func (b *Bus) Publish(kind string, data any) {
	ev := Event{
		Seq:  b.seq.Add(1),
		Type: kind,
		Time: b.now().UTC().Format(time.RFC3339Nano),
		Data: data,
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, s := range b.subs {
		select {
		case s.ch <- ev:
		default:
			s.dropped.Add(1)
		}
	}
}

// Warn and Fail are shorthands used across the managers so user-visible problems
// always reach the UI.
func (b *Bus) Warn(source, message string) {
	b.Publish(TypeWarning, map[string]string{"source": source, "message": message})
}

func (b *Bus) Fail(source, message string) {
	b.Publish(TypeError, map[string]string{"source": source, "message": message})
}

func (b *Bus) Subscribers() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}
