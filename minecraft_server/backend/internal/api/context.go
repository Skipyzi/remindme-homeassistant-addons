package api

import (
	"context"
	"net/http"
	"time"
)

// contextWithTimeout detaches long operations from the HTTP request.
//
// A graceful stop, a backup or a world switch must run to completion even if the
// browser tab that started it goes away, otherwise a closed tab could leave a
// half-finished operation behind. The client learns the outcome from the event
// stream if its own request times out.
func contextWithTimeout(r *http.Request, timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(r.Context()), timeout)
}
