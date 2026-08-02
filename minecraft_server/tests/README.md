# Tests

## Automated

Everything automated lives with the code it tests, in `backend/internal/*/**_test.go`, and
runs with:

```bash
cd ../backend && go test ./...
```

or through `../scripts/test.sh`, which also runs `go vet` and checks the frontend modules
parse.

Paper and restic are replaced by real subprocesses that speak their protocols, built on
demand from `backend/internal/testsupport/`:

| Fake | Emulates | Modes |
| --- | --- | --- |
| `fakepaper` | Console grammar, `stop`, `save-off`, `save-all`, `save-on`, `chunky` | `FAKEPAPER_MODE=ready\|crash_start\|crash_late\|no_ready\|ignore_stop` |
| `fakerestic` | `init`, `backup`, `snapshots`, `ls`, `restore`, `forget`, `check`, `stats` with real dedup accounting | `FAKERESTIC_FAIL=backup\|restore\|check` |

### Coverage map

| Requirement | Test |
| --- | --- |
| Starting and stopping Paper | `supervisor.TestStartReachesRunningAndCapturesConsole`, `TestGracefulStopFlushesAndExitsCleanly` |
| Crash detection | `supervisor.TestCrashIsDetectedWithItsExitCode`, `TestIntentionalStopIsNotACrash` |
| Graceful timeout handling | `supervisor.TestStopTimeoutEscalatesToASignal` |
| No duplicate servers | `supervisor.TestDuplicateStartIsRefused` |
| Configuration validation | `mcconfig.TestValidateRejectsBrokenFormats`, `TestSetKnobsWritesEveryFileOnceAndValidatesRanges` |
| Atomic writes | `atomicfs.TestWriteFileIsAtomicAndLeavesNoTempFiles`, `mcconfig.TestWriteRejectsInvalidContentWithoutTouchingTheFile` |
| Configuration snapshots | `mcconfig.TestWriteCreatesSnapshotAndRefusesUnknownFiles`, `TestSnapshotsArePrunedAndRestorable` |
| Preset application and diff | `presets.TestDiffListsOnlyRealChanges`, `TestApplyWritesKnobsAndSettings`, `TestApplyKeepsManualOverridesUnlessAsked` |
| World creation and cloning | `worlds.TestCreateCloneAndRenameWorlds` |
| ZIP import security | `worlds.TestImportRejectsUnsafeArchives`, `TestImportRejectsSymlinkEntries` |
| World switching rollback | `worlds.TestActivateRollsBackWhenTheNewWorldDoesNotStart`, `TestActivateAbortsWhenTheSafetyBackupFails` |
| Incremental backup | `backups.TestSecondBackupStoresOnlyChangedData` |
| Failed backup recovery | `backups.TestFailedBackupReEnablesSavingAndRecordsTheFailure` |
| Restore rollback | `backups.TestRestoreRollsBackWhenTheServerDoesNotStart` |
| Interrupted restore recovery | `backups.TestReconcileRollsBackAnInterruptedSwap`, `TestReconcileCleansAnInterruptedBackup` |
| Terrain generation scheduling | `generation.TestProfilesWidenOrTightenThePolicy`, `TestHysteresisKeepsAJobPausedInsideTheDeadBand`, `TestResumeWaitsForTheEmptyServerDelay` |
| Player-join generation pause | `generation.TestGuardLoopPausesWhenAPlayerJoins` |
| Thermal generation pause | `generation.TestGuardsPauseOnPlayersTemperatureAndTPS` |
| Low-disk cancellation | `generation.TestLowDiskCancelsTheJob`, `TestEstimateRefusesWithoutEnoughSpace` |
| Storage estimation | `generation.TestMeasureBytesPerChunkReadsRegionHeaders`, `TestChunkCountMatchesShape` |
| Generation job reconciliation | `generation.TestReconcileAdoptsAnInterruptedJobAsPaused` |
| Home Assistant entity commands | `hass.TestCommandsFromHomeAssistantGoThroughTheCommandService`, `TestDiscoveryPayloadsCoverTheDocumentedEntities` |
| Ingress path handling | `api.TestStateChangingRequestsRequireIngressAndTheCustomHeader`, `TestStaticFilesAreServedAndConfined`, `TestIngressPathsWithAPrefixStillResolve` |
| Confirmation for destructive actions | `commands.TestDestructiveWorldAndBackupActionsRequireTheirPhrases`, `TestForceStopRequiresConfirmation` |
| Corrupted state database | `store.TestCorruptDatabaseIsMovedAsideAndRecreated` |
| Secret redaction | `store.TestAuditRedactsSecrets`, `api.TestFailRedactsSecretsInErrorMessages` |
| ARM64 container build | `arm64-build-test.sh` (below) |

## Container build

```bash
./arm64-build-test.sh
```

Builds the image for `linux/arm64` through buildx and checks the controller, Java, restic,
the plugin jar, the frontend and the presets are all present. Skipped automatically when
Docker or buildx is unavailable.

## Fixtures

`fixtures/` holds small inputs used by tests and by hand:

| Fixture | Purpose |
| --- | --- |
| `fixtures/world-archive/` | A minimal, valid world archive layout to zip up for an import test |
| `fixtures/unsafe-archive.md` | How to build the hostile archives the import path must reject |
| `fixtures/chunky-console-lines.txt` | Real Chunky output shapes the log parser must handle |

## Manual

[manual-pi5-test-plan.md](manual-pi5-test-plan.md) covers what only real hardware can:
thermal pauses, real chunk generation, storage throughput, Home Assistant entities and
power-loss recovery.
