// Package mcconfig reads and writes the server's configuration files. Only files
// the backend declares are reachable, every write is validated, snapshotted and
// atomic, and every write is recorded in the audit log.
package mcconfig

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// Properties is an order- and comment-preserving view of a Java properties file.
// Rewriting server.properties from a map would throw away the comments Mojang
// puts there and reorder everything on every save, which makes diffing painful.
type Properties struct {
	lines []string
	index map[string]int
}

func ParseProperties(raw []byte) *Properties {
	p := &Properties{index: map[string]int{}}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	if text == "" {
		return p
	}
	p.lines = strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	for i, line := range p.lines {
		key, _, ok := splitProperty(line)
		if ok {
			p.index[key] = i
		}
	}
	return p
}

func splitProperty(line string) (key, value string, ok bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "!") {
		return "", "", false
	}
	idx := strings.IndexAny(trimmed, "=:")
	if idx < 0 {
		return "", "", false
	}
	return strings.TrimSpace(trimmed[:idx]), strings.TrimSpace(trimmed[idx+1:]), true
}

func (p *Properties) Get(key string) (string, bool) {
	i, ok := p.index[key]
	if !ok {
		return "", false
	}
	_, value, ok := splitProperty(p.lines[i])
	if !ok {
		return "", false
	}
	return unescapeProperty(value), true
}

func (p *Properties) GetOr(key, fallback string) string {
	if v, ok := p.Get(key); ok {
		return v
	}
	return fallback
}

func (p *Properties) GetInt(key string, fallback int) int {
	if v, ok := p.Get(key); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return fallback
}

func (p *Properties) GetBool(key string, fallback bool) bool {
	if v, ok := p.Get(key); ok {
		return strings.EqualFold(strings.TrimSpace(v), "true")
	}
	return fallback
}

// Set updates a key in place, or appends it when it is new.
func (p *Properties) Set(key, value string) {
	line := key + "=" + escapeProperty(value)
	if i, ok := p.index[key]; ok {
		p.lines[i] = line
		return
	}
	p.lines = append(p.lines, line)
	p.index[key] = len(p.lines) - 1
}

func (p *Properties) Delete(key string) {
	i, ok := p.index[key]
	if !ok {
		return
	}
	p.lines = append(p.lines[:i], p.lines[i+1:]...)
	delete(p.index, key)
	// Rebuild the index because the positions after i shifted.
	for k, idx := range p.index {
		if idx > i {
			p.index[k] = idx - 1
		}
	}
}

func (p *Properties) Keys() []string {
	out := make([]string, 0, len(p.index))
	for k := range p.index {
		out = append(out, k)
	}
	return out
}

func (p *Properties) Map() map[string]string {
	out := make(map[string]string, len(p.index))
	for k := range p.index {
		if v, ok := p.Get(k); ok {
			out[k] = v
		}
	}
	return out
}

func (p *Properties) Bytes() []byte {
	if len(p.lines) == 0 {
		return []byte{}
	}
	return []byte(strings.Join(p.lines, "\n") + "\n")
}

// ValidateProperties rejects malformed lines and unsafe keys.
func ValidateProperties(raw []byte) error {
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	for n, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "!") {
			continue
		}
		key, _, ok := splitProperty(line)
		if !ok {
			return fmt.Errorf("line %d is not a comment and has no '=' separator", n+1)
		}
		if !keyPattern.MatchString(key) {
			return fmt.Errorf("line %d has an invalid key %q", n+1, key)
		}
	}
	return nil
}

// escapeProperty encodes the characters a Java properties reader would otherwise
// misinterpret. Non-ASCII is written as \uXXXX because server.properties is read
// as ISO-8859-1 by the vanilla loader.
func escapeProperty(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '=':
			b.WriteString(`\=`)
		case ':':
			b.WriteString(`\:`)
		default:
			if r > 126 {
				b.WriteString(fmt.Sprintf(`\u%04X`, r))
			} else {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

func unescapeProperty(value string) string {
	var b strings.Builder
	runes := []rune(value)
	for i := 0; i < len(runes); i++ {
		if runes[i] != '\\' || i+1 >= len(runes) {
			b.WriteRune(runes[i])
			continue
		}
		i++
		switch runes[i] {
		case 'n':
			b.WriteRune('\n')
		case 'r':
			b.WriteRune('\r')
		case 't':
			b.WriteRune('\t')
		case 'u':
			if i+4 < len(runes) {
				if code, err := strconv.ParseInt(string(runes[i+1:i+5]), 16, 32); err == nil {
					b.WriteRune(rune(code))
					i += 4
					continue
				}
			}
			b.WriteRune('u')
		default:
			b.WriteRune(runes[i])
		}
	}
	return b.String()
}
