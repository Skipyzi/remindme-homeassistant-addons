# llama-server Readiness Retry Design

## Problem

The model manager launches `llama-server` and immediately invokes a single health/completion probe. The probe receives `connection refused` while llama.cpp is still loading the model, even though the manager creates a 120-second timeout context. Because no retry loop exists, the first transient failure stops the process and leaves startup degraded.

Internal target `http://127.0.0.1:8081` is correct: the manager and llama-server run in the same add-on container.

## Goals

- Allow llama-server up to 120 seconds to become healthy.
- Probe immediately, then retry transient failures every 500 milliseconds.
- Require both `/health` and a deterministic completion probe before activation succeeds.
- Fail early when the launched process has already exited.
- Return the last useful probe or process-exit error.
- Preserve activation rollback and persisted-state behavior.

## Design

`Supervisor.probeWithTimeout` will accept the launched `Process`. It will run the configured probe repeatedly under the existing 120-second child context. A failed probe does not stop the process immediately. The supervisor checks whether the process has exited, then waits for either the next 500-millisecond retry or context cancellation.

A small optional process-status interface will expose non-consuming exit state:

```go
type ProcessStatus interface {
    Exited() bool
}
```

`commandProcess` maintains an `atomic.Bool` set by its existing wait goroutine immediately before the result is sent to `done`. `Exited` reads that flag without consuming the channel, preserving `Stop` and `Wait` behavior without a data race. Test fakes may implement this interface to verify early-exit handling; processes without it continue using timeout-based retry.

On deadline, the method returns the last probe error wrapped with a readiness-timeout message. When the process exits, it returns an early process-exit message containing the last probe error. No additional process is launched, and the existing caller remains responsible for stopping/clearing state.

## Error Handling

- Initial connection refusal is treated as transient.
- Health HTTP errors and incomplete completion readiness are retried.
- Context cancellation stops retries immediately.
- An exited process fails immediately.
- The last probe error remains visible but no model path, token, signed URL, or credential is added to logs.

## Testing

- A probe that fails twice and then succeeds causes three attempts and a successful start.
- A probe that never succeeds returns the last error after a short injected test timeout or canceled context.
- A fake process reporting exit terminates retries before the timeout.
- Existing activation, rollback, and recovery tests continue passing.
- Go race-independent tests, `go vet`, Linux ARM64 compilation, shell syntax, and the ARM64 Docker build pass.

## Release

Release managed llama.cpp as `1.9.2`. RemindMe does not require a version bump because this change is internal to the llama.cpp add-on.
