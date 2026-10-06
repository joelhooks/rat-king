#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ -f apps/ios/Config/Local.xcconfig ]] || cp apps/ios/Config/Local.xcconfig.example apps/ios/Config/Local.xcconfig
xcodegen generate --spec apps/ios/project.yml
mkdir -p apps/ios/build
log="apps/ios/build/interop-$(date +%s).log"
xcodebuild test -project apps/ios/RatKing.xcodeproj -scheme RatKing \
  -destination "${IOS_TEST_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}" \
  -derivedDataPath apps/ios/build/DerivedData CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$log"
node apps/ios/scripts/verify-swift.ts "$log"
