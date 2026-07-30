package mcconfig

import (
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// YAML editing works on a yaml.Node tree rather than a map so comments, key order
// and formatting of Paper's own configuration files survive a write. Losing
// Paper's inline documentation on every preset application would make the files
// much harder for a human to read afterwards.

// GetYAMLPath reads a dotted path such as
// "chunk-loading-basic.player-max-chunk-send-rate".
func GetYAMLPath(raw []byte, path string) (any, bool, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, false, fmt.Errorf("invalid YAML: %w", err)
	}
	if len(doc.Content) == 0 {
		return nil, false, nil
	}
	node, ok := findNode(doc.Content[0], strings.Split(path, "."))
	if !ok {
		return nil, false, nil
	}
	var out any
	if err := node.Decode(&out); err != nil {
		return nil, false, err
	}
	return out, true, nil
}

func findNode(root *yaml.Node, parts []string) (*yaml.Node, bool) {
	current := root
	for _, part := range parts {
		if current.Kind != yaml.MappingNode {
			return nil, false
		}
		found := false
		for i := 0; i+1 < len(current.Content); i += 2 {
			if current.Content[i].Value == part {
				current = current.Content[i+1]
				found = true
				break
			}
		}
		if !found {
			return nil, false
		}
	}
	return current, true
}

// SetYAMLPath sets a dotted path, creating intermediate mappings when needed, and
// returns the re-serialized document.
func SetYAMLPath(raw []byte, path string, value any) ([]byte, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("invalid YAML: %w", err)
	}
	if len(doc.Content) == 0 {
		doc = yaml.Node{
			Kind:    yaml.DocumentNode,
			Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}},
		}
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("document root is not a mapping")
	}

	parts := strings.Split(path, ".")
	current := root
	for _, part := range parts[:len(parts)-1] {
		next := childMapping(current, part)
		if next == nil {
			return nil, fmt.Errorf("could not create path %q", path)
		}
		current = next
	}
	leaf := parts[len(parts)-1]
	valueNode, err := scalarNode(value)
	if err != nil {
		return nil, err
	}
	setChild(current, leaf, valueNode)

	out, err := marshalIndented(&doc)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func childMapping(parent *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value == key {
			child := parent.Content[i+1]
			if child.Kind == yaml.MappingNode {
				return child
			}
			if child.Kind == yaml.ScalarNode && child.Tag == "!!null" {
				child.Kind = yaml.MappingNode
				child.Tag = "!!map"
				child.Value = ""
				return child
			}
			return nil
		}
	}
	keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	valueNode := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	parent.Content = append(parent.Content, keyNode, valueNode)
	return valueNode
}

func setChild(parent *yaml.Node, key string, value *yaml.Node) {
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value == key {
			// Preserve the comment attached to the existing value.
			value.HeadComment = parent.Content[i+1].HeadComment
			value.LineComment = parent.Content[i+1].LineComment
			value.FootComment = parent.Content[i+1].FootComment
			parent.Content[i+1] = value
			return
		}
	}
	parent.Content = append(parent.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
}

func scalarNode(value any) (*yaml.Node, error) {
	node := &yaml.Node{Kind: yaml.ScalarNode}
	switch v := value.(type) {
	case bool:
		node.Tag, node.Value = "!!bool", strconv.FormatBool(v)
	case int:
		node.Tag, node.Value = "!!int", strconv.Itoa(v)
	case int64:
		node.Tag, node.Value = "!!int", strconv.FormatInt(v, 10)
	case float64:
		// JSON decoding turns every number into a float64; integral values must
		// stay integers or Paper rejects the file.
		if v == float64(int64(v)) {
			node.Tag, node.Value = "!!int", strconv.FormatInt(int64(v), 10)
		} else {
			node.Tag, node.Value = "!!float", strconv.FormatFloat(v, 'f', -1, 64)
		}
	case string:
		node.Tag, node.Value = "!!str", v
	case nil:
		node.Tag, node.Value = "!!null", "null"
	default:
		return nil, fmt.Errorf("unsupported YAML value type %T", value)
	}
	return node, nil
}

func marshalIndented(doc *yaml.Node) ([]byte, error) {
	var sb strings.Builder
	enc := yaml.NewEncoder(&sb)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return []byte(sb.String()), nil
}
