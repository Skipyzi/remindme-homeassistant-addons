package supervisor

import (
	"sync"
	"time"
)

// ConsoleLine is one captured line of Minecraft output.
type ConsoleLine struct {
	Seq    uint64 `json:"seq"`
	Time   string `json:"time"`
	Stream string `json:"stream"` // stdout | stderr | controller
	Text   string `json:"text"`
}

// ring is a bounded console history. Old lines are dropped, which keeps memory
// use flat no matter how chatty a plugin is.
type ring struct {
	mu    sync.RWMutex
	buf   []ConsoleLine
	next  int
	size  int
	count int
	seq   uint64
}

func newRing(size int) *ring {
	if size < 100 {
		size = 100
	}
	return &ring{buf: make([]ConsoleLine, size), size: size}
}

func (r *ring) append(stream, text string) ConsoleLine {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	line := ConsoleLine{
		Seq:    r.seq,
		Time:   time.Now().UTC().Format(time.RFC3339Nano),
		Stream: stream,
		Text:   text,
	}
	r.buf[r.next] = line
	r.next = (r.next + 1) % r.size
	if r.count < r.size {
		r.count++
	}
	return line
}

// since returns lines with Seq > afterSeq, oldest first, capped at limit.
// afterSeq = 0 returns the tail of the history, which is what a page load wants.
func (r *ring) since(afterSeq uint64, limit int) []ConsoleLine {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if limit <= 0 || limit > r.size {
		limit = r.size
	}
	out := make([]ConsoleLine, 0, min(limit, r.count))
	start := (r.next - r.count + r.size) % r.size
	for i := 0; i < r.count; i++ {
		line := r.buf[(start+i)%r.size]
		if line.Seq <= afterSeq {
			continue
		}
		out = append(out, line)
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

func (r *ring) lastSeq() uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.seq
}
