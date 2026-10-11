# Rat King for iPhone

A native SwiftUI terminal client. The phone owns a Secure Enclave P-256 agreement key and signing key. It exports only its public DID document. It holds no operator identity.

The terminal theme, FontBook and Geist Pixel fonts come from the reference app. The fonts retain their OFL licence in `Sources/Resources/Fonts/OFL.txt`. The old firehose, normaliser and CarPlay are not included.

## Configure and build

Install Xcode and XcodeGen (`brew install xcodegen`). Copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig`. The real team, existing bundle identifier, phone DID, mailbox audience and HTTPS mailbox URL go only in that ignored file. Do not put a token in the URL.

Peers come from `mailbox.getPeerDocument` over the phone's authenticated HTTPS connection. The registered public documents are the fleet trust root. After sign-in the phone refreshes its known peers; it looks up an unknown sender before verification and refreshes every reply target before signing. A failed verification gets one refresh and one retry. The first document for a DID is pinned in the protected, backup-excluded peer store. A changed document blocks verification and new sends until Joel reviews the pinned and proposed documents in Identity and accepts the replacement. Forbidden lookup responses stop sync and show the XRPC error; the phone does not change server permissions.

The ignored `Sources/Resources/PeerDocuments.private.json` is an optional first-use seed, never a requirement or an override of an existing pin. Import from Files remains an explicit replacement. Neither lookup nor import gives the phone an operator credential.

From the repo root:

```sh
pnpm ios:check
bash apps/ios/scripts/deploy-testflight.sh --archive-only
```

`ios:check` runs Swift tests on an iPhone 17 Pro simulator and opens the Swift-produced envelope with the TS package. Set `IOS_TEST_DESTINATION` for another installed simulator. Simulator tests use published synthetic software keys only. The app refuses software identity fallback on a simulator.

The desk must confirm profile refresh authorization before setting `RK_PROVISIONING_AUTHORIZED=1`. `--archive-only` uses Xcode's signed-in account and checks existing Apple Development and Distribution identities for the team in the local configuration. Xcode automatically signs the archive for development; export pins the existing distribution identity. It may create or refresh a provisioning profile. It must not create a certificate, revoke anything or extract account credentials. It does not upload.

Marketing version starts at `0.2.0`; build number is the UTC `YYYYMMDDHHMM` timestamp. Both appear in the archive output. If Apple rejects the marketing version as too low, the desk may authorize one minor-version retry through `RK_MARKETING_VERSION`. The app displays its version, build and exact source commit.

After the desk authorizes the exact upload, set `RK_UPLOAD_AUTHORIZED=1` and run `--upload`. It uses `xcodebuild -exportArchive` with `destination: upload` and the existing distribution certificate. It refuses an archive from a different commit or a dirty checkout. No API key or application password is required. Private signing keychain and password-file paths come from `RK_SIGNING_KEYCHAIN_PATH` and `RK_SIGNING_KEYCHAIN_PASSWORD_FILE` in the ignored xcconfig. The script unlocks that keychain before archive and again before export through `security -i`; the password is never placed on argv or logged. It does not change the search list, lock timeout or key access permissions. A successful upload is not proof of processing, installation or live mail.

## Join and prove

1. Open the app on a physical iPhone with the mailbox reachable. Share the public DID document from Identity. Save the exact JSON for the desk.
2. The desk runs `mailbox register --did <phone-did> --document <public-json>` using its existing operator configuration. The phone never receives those credentials. Registration refuses private material and a mismatched DID. Exact retries use the server's idempotent registration route.
3. The phone looks up the agent's registered public DID document when needed. A bundled seed or manual import is optional.
4. Keep the app open. It acquires its own five-minute `runtime.lease#other` binding with `kind: ios`, renews every two minutes, authenticates the WebSocket in its first frame, waits for the ready notice, then lists the recipient log.
5. An agent sends the phone an encrypted message. The phone decrypts and verifies it locally, marks injection with `mailbox.deliver`, and shows the body. Tap **ACK READ** after reading; admission and decryption alone are not acknowledgment.
6. Reply inside a conversation or the message/thread detail. The phone refreshes the original sender's document, signs inside the Secure Enclave and sets `replyTo` to the original message ref. Replies and new messages use signed plaintext by default, with an explicit not-encrypted label. Desk answers retain encrypted sealing. The agent must verify the reply and compare the content. Capture both message refs and the final receipts privately.

The phone resolves only its own lease, so it does not need `LEASE_RESOLVERS` membership. The desk owns any server allowlist or pilot configuration changes.

## Runtime boundaries

- Live delivery is foreground-only. There is no APNs/background push promise. Going inactive cancels the owned socket/task. If an older install still holds the phone's lease, the app resolves only its own DID, shows `waiting for previous session (m:ss)` and retries at that lease's expiry. It does not borrow the old session's fence or release a lease it does not own.
- `InboxStore.swift` has one switch-based lifecycle projection and generation-token fencing for stale tasks. The desk approved this native projection instead of embedding a JS runtime.
- A list snapshot keeps `afterSeq` fixed across pages and checks the watermark. It advances the in-memory checkpoint only after processing all pages. Process restarts replay from zero and deduplicate against the local inbox. Decrypted threads and visibility preferences stay in an atomic, complete-file-protected Application Support store excluded from backup. Bodies never enter logs or notifications.
- Pending sends save the signed envelope (encrypted or plaintext) before admission. Desk answers also save their local thread key and answer projection under complete file protection, so retry marks the original thread sent and retains its selections. Retry uses the same message ID and sealed bytes with fresh JWT and lease fence. A pending send is retried explicitly; editing the draft does not replace it.
- Keychain stores Secure Enclave-wrapped key references with `WhenUnlockedThisDeviceOnly`, not exportable scalars. On first upgrade, the app copies the unique prior DID-scoped references into a stable device slot. Changing the DID reuses those same keys and rewrites only the public document's controller/key IDs. Old slots stay intact for rollback. Read failures, conflicting references or multiple distinct prior identities fail closed, never generate replacement keys.
- Local stores are scoped by phone DID and mailbox audience. A transport change starts a separate inbox, peers and outbox. Old files remain untouched; pending envelopes and acknowledgments from the previous network are not replayed into the new one.
- Canonical encoding preserves unknown integer/string/map/array/byte/bool/null fields. Unsupported floating-point values and CID tags fail closed. All fixture extension fields participate in AAD/signature bytes.
- Expired, acked or failed historical admissions are displayed without offering ACK until their later receipt establishes the current state. Unknown event kinds stop catch-up rather than silently skip.

## Conversations

Chats is the first tab. It lists one conversation per peer, newest first: agent name, callsign, project, last message preview, time, unread count, latest status and whether a desk decision or approval needs an answer. The name and project come from the fleet DID (`<project>.<row>.<kind>`). The callsign is the latest `label` the agent signed into a pi-ratking payload.

A conversation is projected from what the phone already stores, with no server change and no extra file: Mail in both directions, sealed desk answers saved with their thread and the memory-only Traffic rows between this phone and that peer. A message present in both Mail and Traffic shows once. Entries run in TID order. Each reply quotes and indents under the message it answers, using the envelope `replyTo` or the payload's answered ID. Desk items keep their own threads. A desk card also appears in its sender's conversation and opens that thread. The reply box sits at the bottom. It answers the latest incoming message, a message picked with `[reply]`, or nothing after `[x new]`. Every send is signed plaintext from this phone through the pending-send path. It goes out as a pi-ratking payload whose `from` is the fleet name the phone's DID was provisioned from. The payload carries a one-line `summary`: the optional summary field, else the body's first sentence, at most 280 UTF-16 units. A DID without a valid fleet name sends the plain body with no summary. The decoder reads `summary` next to `label`, and the stored raw text keeps every unknown field. New messages and replies keep a local outgoing copy after admission so that they appear in the conversation. Archiving a conversation archives and acknowledges its threads.

`[+ new message]` opens a searchable picker of known agents, with name, callsign and project, and shows recently messaged agents first. The list is the pinned peers plus every conversation peer, never a typed DID. Picking an agent opens its conversation with the composer focused. The send path refreshes the peer document (`getPeerDocument`) before signing, as before.

Chats, Mail and Traffic each have a filter bar: all, unread, needs answer, archived, plus a project menu and a search field. Search is local and in memory. It matches agent name, callsign, project and message text, and every term must match, ignoring case and accents. Nothing is indexed or written. Filters survive tab switches and reset at process restart. In Traffic, unread means not yet opened on this phone (memory-only), and needs answer means a plaintext desk decision or approval.

## Desk inbox

The inbox groups desk threads by project and plain chat by sender DID. It hides rows behind a counted loading state until initial/reconnect catch-up finishes. Live incoming messages, including follow-ups in an existing thread, wait behind a `N new` control; tapping it reveals the complete projection and scrolls to the top. Receipt-only updates do not count as new mail. Pull to refresh restarts foreground sync. Offline errors and the connection state remain visible; replies and acknowledgment require a live lease.

Details keep the native navigation bar so the system edge swipe goes back. Archive + Next archives and acknowledges the current thread, then replaces the detail with the next thread in the visible list. At the end it returns to the list. Failed acknowledgment keeps the current detail open. Delivered incoming messages are labelled unread until explicit ACK READ or archive; opening a detail alone does not acknowledge. Replies use the latest incoming message ref in that thread, remain retryable in the existing outbox and appear as `YOU:` after admission. Archived/restored visibility still does not reverse acknowledgment.

A desk item owns one thread; only updates from that same sender and project can close it. Unknown record types remain chat. Malformed known desk records fail closed.

Options show the suggested pick, its outcome, row toggles and a note. Sending seals `desk.answer` to the item's sender, with the original message TID in `inReplyTo`. Admission marks it sent; `desk.update` marks it resolved or superseded. A sent answer is not proof that the desk acted.

Custom pixel-font swipe rows replace stock swipe chrome. The stationary touch surface arbitrates horizontal pan and tap: tap requires pan failure, so a full or partial swipe cannot navigate. Vertical pans yield to the scroll view. Navigation happens only through the row's explicit tap callback, not a competing `NavigationLink`. A full swipe left archives; a full swipe right opens the terminal-styled snooze picker, with no implicit default. In Archived, a full swipe right restores the thread. The list shows a tight, one-line title plus the card's why or the latest message's first line.

Snooze for an hour, the next local 18:00, tomorrow 09:00 or seven calendar days. Snooze neither sends nor acknowledges. The local notification contains no project, sender or body. It restores visibility at the deadline; foreground sync cancels reminders for closed items. Archive acknowledges delivered mail and hides the thread without answering. The Archived view restores visibility, not the mailbox acknowledgment. A fresh message, update or reply automatically unarchives and un-snoozes its thread and cancels its local reminder. Replayed message IDs and receipt-only changes do not restore hidden threads. Signed plaintext `replyTo` references also join the original card or sent-answer thread, but only when the sender matches that thread's peer; another signer cannot restore it.

TS and Swift share invented fixtures in `packages/lexicon/test/fixtures`. Swift tests drive generated thread command sequences and verify local storage round trips and backup exclusion. Simulator UI tests also drive actual taps and pans through the production row: full-left archive for open/resolved rows, disabled and short swipes, full-right snooze, tap navigation and vertical scrolling. Their launch-only synthetic harness compiles out of Release and touches no mailbox, identity or inbox. The complete-file-protection attribute test requires a physical phone; the simulator skips it. Foreground-only mailbox sync still applies; there is no APNs relay.

`deploy-testflight.sh --export` exports the exact committed archive to a signed IPA locally, with no upload. The desk owns the upload and real-phone answer proof.

## Traffic

The Traffic tab is an observer-only metadata journal, independent of the inbox lease. The desk grants the phone DID observer access; the app receives no operator credentials. Rows show observation time/date, abbreviated sender → recipient, message ID, ciphertext byte count and delivery state, newest first. Each journal event keeps its global and recipient sequence internally. The list groups sender, recipient and message ID into one row, ordered by first observation, with the latest observed status. Repeated receipts update that row instead of adding rows. Signed plaintext text supplied by the mailbox can appear once on the row/detail; encrypted envelopes do not enter the journal. A later receipt without text retains previously observed plaintext.

Selecting Traffic while foregrounded opens `mailbox.subscribeTraffic` without URL parameters or a lease. Its first frame carries a fresh method-bound JWT; the first notice is the ready barrier. `mailbox.listTraffic` then catches up in pages of 100. Only a completely validated page advances the cursor; notice watermarks do not. Socket expiry/loss closes that socket and reconnects with a new JWT and bounded backoff. One generation-fenced task owns the stream, so cancelled requests cannot alter a later session.

Leaving the tab or backgrounding pauses the stream. The in-memory journal and cursor survive tab, foreground and socket reconnects. A process restart replays from zero; no metadata cache is written to disk. Capture begins at server deployment with no earlier backfill. The LIVE/PAUSED indicator reflects this stream, not the inbox lease; RECONNECT explicitly restarts it. A forbidden list response pauses instead of retrying indefinitely.

Tap a Traffic message to inspect its full sender and recipient DIDs, message ID and ciphertext size. Detail shows the message once, its latest status and one compact observation table with UTC timestamps and both sequence numbers. No missing stage is inferred as pending or successful. Selection stays anchored to the routed message while receipts arrive. These are journal observation times, not inferred transport times.

Initial open and reconnect hide the list behind counted catch-up progress. After catch-up, new messages wait behind a `N new` control; tapping reveals them and scrolls up. Status-only changes preserve the current order. Pull to refresh and `r` reconnect restart sync. Edge swipe uses the system navigation bar. Archive + Next hides observer metadata locally and opens the next visible message, without acknowledging another recipient's mail. Restore Archived Traffic restores all those rows. Traffic archives, journal and cursor are memory-only and reset at process restart. Traffic details can reply to the original sender with the same phone-signed pending-send path; they never deliver or acknowledge the original message.

The message-text section shows independently sealed CC copies received by this phone. The v1 client signs the encrypted `sh.mschf.ratking.mailbox.cc` marker, primary sender/message ID/recipient and `replyTo` link. Swift opens and verifies that envelope with the imported sender key before routing it. Copies never enter Mail, desk threads or answer handling. They persist separately in the same protected, backup-excluded inbox store; replay deduplicates the copy's own sender/message ID. Delivery and automatic acknowledgment address only the copy and mean received by this phone, never primary delivery or operator action.

A copy attaches only when its signed primary sender and message ID agree with its signed `replyTo`, and a captured Traffic row matches that sender, primary ID and original recipient. Missing, malformed or mismatched links remain under `UNLINKED COPY`, with the verified actual sender; no arbitrary row fallback exists. Copies that arrive before the primary metadata remain unlinked until that row is captured. Detail shows the original recipient, verified sender, phone receipt time and copied text, explicitly labelled `CC COPY`. Without a matching copy it says `content not copied to this phone`. The Traffic journal still contains only observer metadata; no content fetch or other recipient's envelope decryption is added.

`ios:check` generates a fresh synthetic fixture through the actual TS mailbox client v1 `send(envelope, { cc })` path. Swift opens it and checks the signed marker and primary link, with ciphertext tampering and untrusted-sender rejection. Generated routing commands check that even desk-answer-shaped copy content stays outside Mail, malformed links stay unlinked, storage round trips preserve copies, and deliver/ack calls address only the copy. These tests do not prove real sender CC configuration, physical-device storage or an installed build.

### Pi TUI presentation

The native views adapt these [Pi TUI patterns](https://pi-tui.ratstack.sh/patterns.md); they do not embed the Pi runtime:

- [Detail Lens](https://pi-tui.ratstack.sh/patterns/detail-lens.md): Traffic metadata and compact observation table project one read-only journal snapshot.
- [Identity Anchor](https://pi-tui.ratstack.sh/patterns/identity-anchor.md): Traffic navigation stores sender/recipient/message ID, not a row offset; later receipts do not change the selected message.
- [Tab Deck](https://pi-tui.ratstack.sh/patterns/tab-deck.md): numbered Chats, Mail, Identity and Traffic strip; hardware keyboard Command+1–4 selects tabs without capturing draft numerals.
- [Status Ribbon](https://pi-tui.ratstack.sh/patterns/status-ribbon.md): compact transport/security and count footer with a narrow-width fallback.
- [Shared Shell](https://pi-tui.ratstack.sh/patterns/shared-shell.md): straight borders, section titles and common spacing around the snooze dialog, Identity sections and Traffic detail.
- [Message Fold](https://pi-tui.ratstack.sh/patterns/message-fold.md): conversation and Traffic detail message cards collapse to at most four lines, like pi-ratking's compact view. Line one is the sender with its markers (reply, time, receipt), which never truncate. Then comes the payload `summary`, else the wrapped body, ending `… +N lines` when anything is hidden. Tap unfolds in place, with `Summary:` above the body, and tap again folds. Desk thread lines keep the older four-line preview. Option selection has a marked border and `[x]` indicator.
- [Late Paint](https://pi-tui.ratstack.sh/patterns/late-paint.md) and [Detail Fold](https://pi-tui.ratstack.sh/patterns/detail-fold.md): the fold lays out plain strings per column width, measured from the pixel font's widest glyph, and styles them at render. Chats, Mail and Traffic rows preview the summary, else the body's first line.
- [Palette Deck](https://pi-tui.ratstack.sh/patterns/palette-deck.md): centralized semantic dark/light colours follow the device appearance. The existing pixel font stays.

Hints describe actual touch gestures. Traffic also binds `r` to reconnect and Escape to back. The swipe recognizer, arbitration and four real-touch tests are unchanged. Terminal-column and ANSI-style checks do not apply to SwiftUI; native width/theme review is separate from the reference catalog's 40/60/80/120-column checks. The launch-only Traffic preview uses invented metadata and compiles out of Release.

Tests compare generated append/replay/malformed-page commands and grouped rows against a small journal model. A gated fake transport proves no rows appear before catch-up completes, live arrivals wait for reveal and reconnect hides old rows. Generated presentation commands exercise the shared desk/Traffic gate. Real-touch tests cover native edge swipe back and archive-and-next through the production Traffic detail. A fake observer service drives the real lifecycle through auth/ready, multiple catch-up pages, socket rollover, pause, late notices and foreground resume. These tests do not prove a deployed observer grant or a physical-phone stream.

## Evidence and remaining proof

Interop tests cover the existing Go/TS application vectors, canonical-byte equality and their rejection corpus, all 257 RFC HPKE decryptions, and Swift sealing opened by TS. The iOS SDK typecheck proves that CryptoKit accepts the Secure Enclave recipient type; simulator tests do not prove hardware behavior.

For each new build and transport, capture TestFlight processing/installation, the physical-device public document, registration and a signed two-party exchange. A DID migration also needs a public-coordinate comparison with the prior document to prove both device keys stayed the same. Swipe feel, notification timing, lease-conflict countdown and protected storage while locked still need on-device checks. Simulator properties are not those proofs.
