# Rat King for iPhone

A native SwiftUI terminal client. The phone owns a Secure Enclave P-256 agreement key and signing key. It exports only its public DID document. It holds no operator identity.

The terminal theme, FontBook and Geist Pixel fonts come from the reference app. The fonts retain their OFL licence in `Sources/Resources/Fonts/OFL.txt`. The old firehose, normaliser and CarPlay are not included.

## Configure and build

Install Xcode and XcodeGen (`brew install xcodegen`). Copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig`. The real team, existing bundle identifier, phone DID, mailbox audience and HTTPS mailbox URL go only in that ignored file. Do not put a token in the URL.

Optionally bundle an array of peer public DID documents in the ignored `Sources/Resources/PeerDocuments.private.json`. Otherwise import a document from Files on the Identity tab. Imported public documents are the key authority; the pilot does not expose a DID lookup route. Peer replacement is an explicit import, not trust-on-first-use over the mailbox.

From the repo root:

```sh
pnpm ios:check
bash apps/ios/scripts/deploy-testflight.sh --archive-only
```

`ios:check` runs Swift tests on an iPhone 17 Pro simulator and opens the Swift-produced envelope with the TS package. Set `IOS_TEST_DESTINATION` for another installed simulator. Simulator tests use published synthetic software keys only. The app refuses software identity fallback on a simulator.

The desk must confirm profile refresh authorization before setting `RK_PROVISIONING_AUTHORIZED=1`. `--archive-only` uses Xcode's signed-in account and checks existing Apple Development and Distribution identities for the team in the local configuration. Xcode automatically signs the archive for development; export pins the existing distribution identity. It may create or refresh a provisioning profile. It must not create a certificate, revoke anything or extract account credentials. It does not upload.

Marketing version starts at `0.2.0`; build number is the UTC `YYYYMMDDHHMM` timestamp. Both appear in the archive output. If Apple rejects the marketing version as too low, the desk may authorize one minor-version retry through `RK_MARKETING_VERSION`. The app displays its version, build and exact source commit.

After the desk authorizes the exact upload, set `RK_UPLOAD_AUTHORIZED=1` and run `--upload`. It uses `xcodebuild -exportArchive` with `destination: upload` and the existing distribution certificate. It refuses an archive from a different commit or a dirty checkout. No API key or application password is required. A successful upload is not proof of processing, installation or live mail.

## Join and prove

1. Open the app on a physical iPhone with the mailbox reachable. Share the public DID document from Identity. Save the exact JSON for the desk.
2. The desk runs `mailbox register --did <phone-did> --document <public-json>` using its existing operator configuration. The phone never receives those credentials. Registration refuses private material and a mismatched DID. Exact retries use the server's idempotent registration route.
3. Import the agent's public DID document, or bundle it locally before archiving.
4. Keep the app open. It acquires its own five-minute `runtime.lease#other` binding with `kind: ios`, renews every two minutes, authenticates the WebSocket in its first frame, waits for the ready notice, then lists the recipient log.
5. An agent sends the phone an encrypted message. The phone decrypts and verifies it locally, marks injection with `mailbox.deliver`, and shows the body. Tap **ACK READ** after reading; admission and decryption alone are not acknowledgment.
6. Reply in Compose. The phone signs inside the Secure Enclave and seals to the imported peer key. The agent must open the reply and compare the content. Capture both message refs and the final receipts privately.

The phone resolves only its own lease, so it does not need `LEASE_RESOLVERS` membership. The desk owns any server allowlist or pilot configuration changes.

## Runtime boundaries

- Live delivery is foreground-only. There is no APNs/background push promise. Going inactive cancels the owned socket/task; reopening renews the retained lease or waits for an expired lease to be reacquired.
- `InboxStore.swift` has one switch-based lifecycle projection and generation-token fencing for stale tasks. The desk approved this native projection instead of embedding a JS runtime.
- A list snapshot keeps `afterSeq` fixed across pages and checks the watermark. It advances the in-memory checkpoint only after processing all pages. Process restarts replay from zero; decrypted message bodies are never persisted or logged.
- Encrypted pending sends are saved device-locally before admission. Retry uses the same message ID and sealed bytes with fresh JWT and lease fence. A pending send is retried explicitly; editing the draft does not replace it.
- Keychain stores Secure Enclave-wrapped key references with `WhenUnlockedThisDeviceOnly`, not exportable scalars. The app does not rotate keys after a Keychain read failure.
- Canonical encoding preserves unknown integer/string/map/array/byte/bool/null fields. Unsupported floating-point values and CID tags fail closed. All fixture extension fields participate in AAD/signature bytes.
- Expired, acked or failed historical admissions are displayed without offering ACK until their later receipt establishes the current state. Unknown event kinds stop catch-up rather than silently skip.

## Evidence and remaining proof

Interop tests cover the existing Go/TS application vectors, canonical-byte equality and their rejection corpus, all 257 RFC HPKE decryptions, and Swift sealing opened by TS. The iOS SDK typecheck proves that CryptoKit accepts the Secure Enclave recipient type; simulator tests do not prove hardware behavior.

Still required before calling this live: physical-device Secure Enclave receive/sign behavior, registration against the pilot, foreground socket/reconnect/lease behavior, the two-party encrypted exchange, signed export, TestFlight processing and installation. There are no extra example tests claiming those outcomes.
