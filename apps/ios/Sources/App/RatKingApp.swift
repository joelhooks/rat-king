import SwiftUI
import UIKit
import UniformTypeIdentifiers

@main
struct RatKingApp: App {
    @UIApplicationDelegateAdaptor(PushNotifications.self) private var notifications

    init() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--inbox-benchmark") { InboxBenchmarkView.markLaunch() }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--terminal-gesture-test") { TerminalGestureHarness() }
            else if ProcessInfo.processInfo.arguments.contains("--traffic-preview-test") { TrafficPreviewHarness() }
            else if ProcessInfo.processInfo.arguments.contains("--conversation-test") { ConversationHarness() }
            else if ProcessInfo.processInfo.arguments.contains("--timeline-test") { ConversationHarness(timeline: true) }
            else if ProcessInfo.processInfo.arguments.contains("--inbox-benchmark") { InboxBenchmarkView() }
            else { TerminalView(notifications: notifications) }
            #else
            TerminalView(notifications: notifications)
            #endif
        }
    }
}
struct TerminalView: View {
    let notifications: PushNotifications
    @State private var pushRoute: ChatRoute?
    @State private var attemptedTap: PushTap?
    @State private var store = InboxStore()
    @State private var tab = 0
    @State private var filters = ListFilters()
    @State private var importing = false
    @State private var copiedPublicDocument: String?
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("RAT KING").foregroundStyle(TUITheme.accent).font(TUITheme.titleFont)
                Text("⌘1–5 tabs").foregroundStyle(TUITheme.dim).font(TUITheme.microFont)
                Spacer()
                Circle().fill((tab == 3 ? store.traffic?.state == .live : store.state == .live) ? TUITheme.ok : TUITheme.warn).frame(width: 5, height: 5)
                Text(tab == 3 ? (store.traffic?.state.rawValue.uppercased() ?? "PAUSED") : store.state.rawValue.uppercased()).font(TUITheme.microFont)
            }.padding(8).background(TUITheme.panel)
            ThinDivider()
            HStack(spacing: 8) {
                ForEach(Array(["CHATS", "MAIL", "IDENTITY", "TRAFFIC", "TIMELINE"].enumerated()), id: \.offset) { index, label in
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
                case 0: ConversationsView(store: store, filters: filters, pushRoute: $pushRoute)
                case 1: DeskInboxView(store: store, filter: $filters.desk)
                case 3:
                    if let traffic = store.traffic { TrafficView(store: traffic, inbox: store, copies: store.copies, filter: $filters.traffic) } else { Text("Phone identity required for traffic.").foregroundStyle(TUITheme.warn) }
                case 4: TimelineView(store: store)
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
        .task(id: scenePhase) { if scenePhase == .active { await notifications.enable() } }
        .onChange(of: notifications.device, initial: true) { _, device in store.pushDevice = device }
        .onChange(of: notifications.pendingTap, initial: true) { _, _ in attemptedTap = nil; openNotification() }
        .onChange(of: store.state) { _, _ in openNotification() }
        .onChange(of: store.loadingOlder) { _, _ in openNotification() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.start(); if tab == 3 { store.traffic?.start() } }
            else { store.stop(); attemptedTap = nil }
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
    private func openNotification() {
        guard let tap = notifications.pendingTap else { return }
        if let route = store.route(for: tap) {
            notifications.pendingTap = nil
            tab = 0
            pushRoute = route
        } else if store.state == .live, !store.loadingOlder {
            if attemptedTap == tap || tap.seq == nil { notifications.pendingTap = nil }
            else { attemptedTap = tap; store.loadPushTarget(tap) }
        }
    }
    private var identity: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                TerminalPanel(title: "DEVICE IDENTITY") {
                    Text(store.identity?.did ?? "NO DEVICE IDENTITY").foregroundStyle(TUITheme.teal).textSelection(.enabled)
                    Text("Two device-only keys. No operator credentials. Share the public document with the desk for registration.").foregroundStyle(TUITheme.dim)
                    if let document = store.publicDocument {
                        Button(copiedPublicDocument == document ? "Copied public document" : "Copy public document") {
                            UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: document]], options: [.expirationDate: Date.now.addingTimeInterval(600)])
                            copiedPublicDocument = document
                        }.frame(minHeight: 44).foregroundStyle(TUITheme.accent)
                        ShareLink(item: document) { Text("Share public document") }.foregroundStyle(TUITheme.accent)
                    }
                }
                TerminalPanel(title: "PUBLIC DOCUMENT") {
                    Text(store.publicDocument ?? "Identity unavailable").textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
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
                Text(notifications.status ?? store.pushStatus ?? "Push requires notification permission and APNs configured on the server.").foregroundStyle(TUITheme.dim)
                Text("Mail opens and decrypts only in the foreground.").foregroundStyle(TUITheme.dim)
                Text("BUILD \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") / \(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?")").foregroundStyle(TUITheme.dim)
                Text("COMMIT " + (Bundle.main.object(forInfoDictionaryKey: "RKBuildCommit") as? String ?? "development")).foregroundStyle(TUITheme.dim).textSelection(.enabled)
            }.padding(12)
        }
    }
}
