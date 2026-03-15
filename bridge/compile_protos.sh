#!/bin/bash
# Compile all proto files into bridge/grpc-bridge/proto/ as a flat Go package
set -e

PROTOC="/home/rwood/protoc/bin/protoc"
PROTO_ROOT="/mnt/d/trailrunner/bridge/protos"
OUT_DIR="/mnt/d/trailrunner/bridge/grpc-bridge/proto"
GO_PKG="trailrunner-bridge/proto"

export PATH="/home/rwood/go/bin:$PATH"

# Collect ALL .proto files for M-mapping
PROTOS=$(find "$PROTO_ROOT" -name "*.proto" -printf "%P\n" | sort)

# Build M-options: map every proto to the same Go package
M_OPTS=""
for p in $PROTOS; do
  M_OPTS="$M_OPTS --go_opt=M${p}=${GO_PKG} --go-grpc_opt=M${p}=${GO_PKG}"
done

# List of protos to compile (services + their dependencies)
COMPILE_LIST=(
  # Already-compiled base protos (recompile for consistency)
  util/Util.proto
  util/NetworkError.proto
  util/IFitError.proto
  util/InputError.proto
  util/ConnectionError.proto
  auth/AuthError.proto
  activitylog/ActivityLogUtils.proto
  activitylog/ActivityLogMetadata.proto
  activitylog/ActivityLogError.proto
  workout/WorkoutState.proto
  workout/WorkoutError.proto
  workout/WorkoutResult.proto
  workout/data/ControlType.proto
  workout/data/Control.proto

  # Existing services
  workout/SpeedService.proto
  workout/InclineService.proto
  workout/WorkoutService.proto
  workout/DistanceService.proto
  workout/CaloriesBurnedService.proto
  workout/HeartRateService.proto
  workout/data/WorkoutType.proto
  workout/data/WorkoutTargetType.proto
  workout/data/WorkoutCategory.proto
  workout/data/WorkoutFilter.proto
  workout/data/ItemType.proto
  workout/data/ScaledControls.proto
  workout/data/video/MusicRegion.proto
  workout/data/video/VideoSourceHls.proto
  workout/data/video/VideoSourceStream.proto
  workout/data/video/Sources.proto
  workout/data/map/MapCoordinate.proto
  workout/data/Workout.proto
  workout/data/WorkoutSessionItem.proto
  workout/data/WorkoutSessionState.proto
  workout/data/recovery/RecoveredWorkoutSessionItem.proto
  workout/data/recovery/RecoveredSession.proto

  # NEW: ProgrammedWorkoutSessionService
  workout/ProgrammedWorkoutSessionError.proto
  workout/ProgrammedWorkoutSessionService.proto

  # NEW: ConsoleService
  settings/SystemUnitsService.proto
  console/ConsoleType.proto
  console/ConsoleState.proto
  console/ConsoleInfo.proto
  console/ConsoleService.proto
  console/ConsoleError.proto

  # Elapsed time + elevation (already used)
  workout/data/RingState.proto
)

echo "Compiling ${#COMPILE_LIST[@]} proto files..."

$PROTOC \
  --proto_path="$PROTO_ROOT" \
  --go_out="$OUT_DIR" --go_opt=paths=source_relative \
  --go-grpc_out="$OUT_DIR" --go-grpc_opt=paths=source_relative \
  $M_OPTS \
  "${COMPILE_LIST[@]}"

echo "Compilation complete."

# Move all generated files to flat directory (protoc generates subdirectories with source_relative)
find "$OUT_DIR" -mindepth 2 -name "*.go" -exec mv {} "$OUT_DIR/" \;
# Clean up empty subdirectories
find "$OUT_DIR" -mindepth 1 -type d -empty -delete

echo "All .go files moved to flat proto/ directory."
ls -la "$OUT_DIR"/*.go | wc -l
echo "proto files generated."
