//go:build !linux

package hardware

import (
	"errors"
	"runtime"
)

func diskFree(_ string) (int64, error) {
	return 0, errors.New("disk facts are only available on the Linux add-on target: " + runtime.GOOS)
}
