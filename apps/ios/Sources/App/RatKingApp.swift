import SwiftUI
import UniformTypeIdentifiers

@main
struct RatKingApp: App {
    var body: some Scene { WindowGroup { TerminalView() } }
}
struct TerminalView: View {
    @State private var store = InboxStore()
    @State private var tab = 0
    @State private var recipient = ""
    @State private var draft = ""
    @State private var importing = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("RAT KING").foregroundStyle(TUITheme.accent).font(TUITheme.titleFont)
                Spacer()
                Circle().fill(store.state == .live ? TUITheme.ok : TUITheme.warn).frame(width: 5, height: 5)
                Text(store.state.rawValue.uppercased()).font(TUITheme.microFont)
            }.padding(12).background(TUITheme.panel)
            ThinDivider()
            HStack(spacing: 24) {
                ForEach(Array(["MAIL", "COMPOSE", "IDENTITY"].enumerated()), id: \.offset) { index, label in
                    Button { tab = index } label: { Text("[\(label)]").foregroundStyle(tab == index ? TUITheme.accent : TUITheme.dim) }
                }
                Spacer()
            }.padding(12)
            ThinDivider()
            if let error = store.lastError { Text("! " + error).foregroundStyle(TUITheme.err).frame(maxWidth: .infinity, alignment: .leading).padding(12).textSelection(.enabled) }
            Group {
                switch tab {
                case 0: inbox
                case 1: compose
                default: identity
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            ThinDivider()
            HStack {
                Text("E2EE / P-256 / SECURE ENCLAVE")
                Spacer()
                Text("\(store.messages.count) MAIL")
            }.font(TUITheme.microFont).foregroundStyle(TUITheme.dim).padding(12)
        }
        .font(TUITheme.monoFont).foregroundStyle(TUITheme.fg).background(TUITheme.bg)
        .preferredColorScheme(.dark)
        .task { if scenePhase == .active { store.start() } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { store.start() } else { store.stop(); draft = "" } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            if case let .success(url) = result {
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) { store.importPeers(data) }
            }
        }
    }
    private var inbox: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if store.messages.isEmpty { Text("Waiting for encrypted mail.\nKeep the app open with Tailscale connected.").foregroundStyle(TUITheme.dim).padding(.vertical, 20) }
                ForEach(store.messages) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text("FROM " + item.sender).foregroundStyle(TUITheme.teal); Spacer(); Text(item.receipt.uppercased()).foregroundStyle(TUITheme.dim) }
                        Text(item.text).textSelection(.enabled)
                        HStack {
                            Button("[REPLY]") { recipient = item.sender; tab = 1 }
                            if item.receipt == "delivered" { Button("[ACK READ]") { Task { await store.acknowledge(item) } }.disabled(store.state != .live) }
                        }.foregroundStyle(TUITheme.accent)
                    }.padding(12).background(TUITheme.panel)
                }
            }.padding(12)
        }
    }
    private var compose: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("TO").foregroundStyle(TUITheme.dim)
            Picker("Recipient", selection: $recipient) {
                Text("Select peer").tag("")
                ForEach(store.peers.keys.sorted(), id: \.self) { Text($0).tag($0) }
            }.tint(TUITheme.teal)
            TextEditor(text: $draft).font(TUITheme.monoFont).scrollContentBackground(.hidden).padding(8).background(TUITheme.panel)
            if store.hasPendingSend { Text("Encrypted send pending. Retry sends the SAME envelope, not the current draft.").foregroundStyle(TUITheme.warn) }
            if let receipt = store.lastSend { Text("LAST SEND: " + receipt.uppercased()).foregroundStyle(TUITheme.ok) }
            Button(store.hasPendingSend ? "[RETRY PENDING SEND]" : "[SEAL + SEND]") {
                Task { await store.send(to: recipient, text: draft); if !store.hasPendingSend, store.lastError == nil { draft = "" } }
            }.disabled(store.state != .live || store.sending).foregroundStyle(TUITheme.accent)
        }.padding(12)
    }
    private var identity: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(store.identity?.did ?? "NO DEVICE IDENTITY").foregroundStyle(TUITheme.teal).textSelection(.enabled)
                Text("Two device-only keys. No operator credentials. Share the public document with the desk for registration.").foregroundStyle(TUITheme.dim)
                ShareLink(item: store.publicDocument) { Text("[SHARE PUBLIC DID DOCUMENT]") }.disabled(store.identity == nil).foregroundStyle(TUITheme.accent)
                Text(store.publicDocument).textSelection(.enabled).padding(12).background(TUITheme.panel)
                Button("[IMPORT PEER DID DOCUMENT]") { importing = true }.foregroundStyle(TUITheme.accent)
                ForEach(store.peers.keys.sorted(), id: \.self) { Text($0).foregroundStyle(TUITheme.dim) }
                Text("Live mail runs while this app is in the foreground. Reopening catches up from the mailbox. Background push is not enabled.").foregroundStyle(TUITheme.dim)
                Text("BUILD \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") / \(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?")").foregroundStyle(TUITheme.dim)
                Text("COMMIT " + (Bundle.main.object(forInfoDictionaryKey: "RKBuildCommit") as? String ?? "development")).foregroundStyle(TUITheme.dim).textSelection(.enabled)
            }.padding(12)
        }
    }
}
