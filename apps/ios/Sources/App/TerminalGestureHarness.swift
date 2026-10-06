import SwiftUI

#if DEBUG
// Launch-only UI test surface. Uses the actual production row and archive gate;
// it neither constructs a phone identity nor touches a mailbox or local inbox.
struct TerminalGestureHarness: View {
    @State private var archived = false
    @State private var archives = 0
    @State private var snoozes = 0
    @State private var opens = 0
    @State private var path: [String] = []
    private var thread: InboxThread {
        var value = InboxThread(id: "synthetic", sender: "did:web:sample.example.invalid", project: "sample", itemId: nil)
        value.state = ProcessInfo.processInfo.arguments.contains("--resolved") ? .resolved : .open; value.archived = archived
        return value
    }
    var body: some View {
        NavigationStack(path: $path) {
            VStack {
                Text("open=\(opens) archive=\(archives) snooze=\(snoozes)").accessibilityIdentifier("gesture-counts")
                ScrollView {
                    VStack(spacing: 4) {
                        TerminalSwipeRow(archiveLabel: "[ARCHIVE]", snoozeLabel: "[SNOOZE]", canArchive: canArchiveThread(thread, connection: .live), canSnooze: thread.state == .open,
                            archive: { archives += 1; archived = true }, snooze: { snoozes += 1 }, open: { opens += 1; path.append("synthetic") }) {
                            Text(thread.state == .resolved ? "Resolved synthetic thread" : "Open synthetic thread").frame(minHeight: 44)
                        }.accessibilityIdentifier("gesture-row")
                        ForEach(0..<50) { index in Text("Synthetic row \(index)").frame(maxWidth: .infinity, minHeight: 36).accessibilityIdentifier("scroll-\(index)") }
                    }.padding(8)
                }.accessibilityIdentifier("gesture-scroll")
            }.navigationDestination(for: String.self) { _ in Text("OPENED THREAD").accessibilityIdentifier("gesture-destination") }
            .toolbar(.hidden, for: .navigationBar)
        }.font(TUITheme.monoFont).foregroundStyle(TUITheme.fg).background(TUITheme.bg)
    }
}
#endif
