import SwiftUI
import UniformTypeIdentifiers

@main
struct RatKingApp: App {
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--terminal-gesture-test") { TerminalGestureHarness() }
            else if ProcessInfo.processInfo.arguments.contains("--traffic-preview-test") { TrafficPreviewHarness() }
            else if ProcessInfo.processInfo.arguments.contains("--conversation-test") { ConversationHarness() }
            else { TerminalView() }
            #else
            TerminalView()
            #endif
        }
    }
}
struct TerminalView: View {
    @State private var store = InboxStore()
    @State private var tab = 0
    @State private var filters = ListFilters()
    @State private var importing = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("RAT KING").foregroundStyle(TUITheme.accent).font(TUITheme.titleFont)
                Text("⌘1–4 tabs").foregroundStyle(TUITheme.dim).font(TUITheme.microFont)
                Spacer()
                Circle().fill((tab == 3 ? store.traffic?.state == .live : store.state == .live) ? TUITheme.ok : TUITheme.warn).frame(width: 5, height: 5)
                Text(tab == 3 ? (store.traffic?.state.rawValue.uppercased() ?? "PAUSED") : store.state.rawValue.uppercased()).font(TUITheme.microFont)
            }.padding(8).background(TUITheme.panel)
            ThinDivider()
            HStack(spacing: 8) {
                ForEach(Array(["CHATS", "MAIL", "IDENTITY", "TRAFFIC"].enumerated()), id: \.offset) { index, label in
                    Button { tab = index } label: {
                        Text(tab == index ? "[\(index + 1) \(label)]" : "\(index + 1) \(label)")
                            .foregroundStyle(tab == index ? TUITheme.accent : TUITheme.dim)
                            .font(TUITheme.microFont).lineLimit(1).minimumScaleFactor(0.8)
                            .padding(.vertical, 10)
                    }.keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                        .accessibilityAddTraits(tab == index ? .isSelected : [])
                }
                Spacer()
            }.padding(8)
            ThinDivider()
            if tab != 3, let waiting = store.waitingMessage { Text(waiting).foregroundStyle(TUITheme.warn).frame(maxWidth: .infinity, alignment: .leading).padding(8) }
            if tab != 3 || store.traffic == nil, let error = store.lastError { Text("! " + error).foregroundStyle(TUITheme.err).frame(maxWidth: .infinity, alignment: .leading).padding(12).textSelection(.enabled) }
            Group {
                switch tab {
                case 0: ConversationsView(store: store, filters: filters)
                case 1: DeskInboxView(store: store, filter: $filters.desk)
                case 3:
                    if let traffic = store.traffic { TrafficView(store: traffic, inbox: store, copies: store.copies, filter: $filters.traffic) } else { Text("Phone identity required for traffic.").foregroundStyle(TUITheme.warn) }
                default: identity
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            ThinDivider()
            ViewThatFits(in: .horizontal) {
                HStack {
                    Text(tab == 3 ? "OBSERVER / SEALED CC" : "SIGNED / SECURE ENCLAVE")
                    Spacer()
                    Text(tab == 3 ? "\(store.traffic?.journal.messages.count ?? 0) MESSAGES" : "\(store.messages.count) MAIL")
                }
                Text(tab == 3 ? "\(store.traffic?.journal.messages.count ?? 0) MESSAGES / METADATA" : "\(store.messages.count) MAIL / SIGNED")
            }.font(TUITheme.microFont).foregroundStyle(TUITheme.dim).padding(12)
        }
        .font(TUITheme.monoFont).foregroundStyle(TUITheme.fg).background(TUITheme.bg)
        .task { if scenePhase == .active { store.start(); if tab == 3 { store.traffic?.start() } } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.start(); if tab == 3 { store.traffic?.start() } } else { store.stop() }
        }
        .onChange(of: tab) { _, selected in
            if selected == 3, scenePhase == .active { store.traffic?.start() } else { store.traffic?.stop() }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            if case let .success(url) = result {
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) { store.importPeers(data) }
            }
        }
    }
    private var identity: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                TerminalPanel(title: "DEVICE IDENTITY") {
                    Text(store.identity?.did ?? "NO DEVICE IDENTITY").foregroundStyle(TUITheme.teal).textSelection(.enabled)
                    Text("Two device-only keys. No operator credentials. Share the public document with the desk for registration.").foregroundStyle(TUITheme.dim)
                    ShareLink(item: store.publicDocument) { Text("[share public DID]") }.disabled(store.identity == nil).foregroundStyle(TUITheme.accent)
                }
                TerminalPanel(title: "PUBLIC DOCUMENT") {
                    Text(store.publicDocument).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                TerminalPanel(title: "TRUSTED PEERS / \(store.peers.count)") {
                    Button("[import peer DID]") { importing = true }.foregroundStyle(TUITheme.accent)
                    ForEach(store.peers.keys.sorted(), id: \.self) { Text("› " + $0).foregroundStyle(TUITheme.dim).textSelection(.enabled) }
                    ForEach(store.peerChanges.keys.sorted(), id: \.self) { did in
                        Text("! DOCUMENT CHANGED: " + did).foregroundStyle(TUITheme.err)
                        if let candidate = store.peerChanges[did], let bytes = try? candidate.value.jsonData() {
                            Text("PROPOSED " + String(decoding: bytes, as: UTF8.self)).font(TUITheme.microFont).textSelection(.enabled)
                        }
                        if let previous = store.peers[did], let bytes = try? previous.value.jsonData() {
                            Text("PINNED " + String(decoding: bytes, as: UTF8.self)).font(TUITheme.microFont).textSelection(.enabled)
                        }
                        Button("[accept changed document]") { store.acceptPeerChange(did); store.refresh() }.foregroundStyle(TUITheme.warn)
                    }
                }
                Text("Live mail runs while this app is in the foreground. Reopening catches up from the mailbox. Background push is not enabled.").foregroundStyle(TUITheme.dim)
                Text("BUILD \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") / \(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?")").foregroundStyle(TUITheme.dim)
                Text("COMMIT " + (Bundle.main.object(forInfoDictionaryKey: "RKBuildCommit") as? String ?? "development")).foregroundStyle(TUITheme.dim).textSelection(.enabled)
            }.padding(12)
        }
    }
}
