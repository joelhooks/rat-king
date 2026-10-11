import SwiftUI

enum ChatRoute: Hashable { case picker, conversation(String, focus: Bool), desk(String) }

struct ConversationsView: View {
    let store: InboxStore
    @Bindable var filters: ListFilters
    @State private var path: [ChatRoute] = []
    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    let archived = filters.conversations.scope == .archived
                    HStack {
                        Text(archived ? "[ARCHIVED CHATS]" : "[CHATS]").foregroundStyle(TUITheme.accent)
                        Spacer()
                        Button("[+ new message]") { path.append(.picker) }.foregroundStyle(TUITheme.accent).accessibilityIdentifier("new-message")
                    }.padding(.vertical, 8)
                    TerminalHints(text: archived ? "tap → conversation · swipe right → restore" : "tap → conversation · ← archive · + → pick an agent")
                    if store.hasPendingSend {
                        HStack {
                            Text("Saved send pending.").foregroundStyle(TUITheme.warn)
                            Spacer()
                            Button("[RETRY PENDING SEND]") { Task { await store.send(to: "", text: "") } }.disabled(store.state != .live || store.sending).foregroundStyle(TUITheme.accent)
                        }.padding(.vertical, 4)
                    }
                    if store.presentation.loading {
                        Text("loading \(store.presentation.progress)…").foregroundStyle(TUITheme.warn)
                    } else {
                        let all = store.conversations
                        TerminalFilterBar(filter: $filters.conversations, projects: all.flatMap(\.projects))
                        let shown = all.filter { filters.conversations.admits($0.facts) }
                        if shown.isEmpty { Text(all.isEmpty ? "No conversations yet. Start one with + new message." : "Nothing matches this filter.").foregroundStyle(TUITheme.dim).padding(.vertical, 8) }
                        ForEach(shown) { conversation in
                            TerminalSwipeRow(archiveLabel: "[ARCHIVE]", snoozeLabel: archived ? "[RESTORE]" : "",
                                canArchive: !conversation.archived && !conversation.threadIds.isEmpty && store.state == .live, canSnooze: archived,
                                archive: { Task { await archive(conversation) } },
                                snooze: { for thread in store.threads where conversation.threadIds.contains(thread.id) { store.restore(thread) } },
                                open: { path.append(.conversation(conversation.id, focus: false)) }) {
                                ConversationRow(conversation: conversation)
                            }
                        }
                    }
                }.padding(8)
            }.refreshable { store.refresh() }
            .background(TUITheme.bg).toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: ChatRoute.self) { route in
                switch route {
                case .picker:
                    AgentPickerView(directory: store.agents) { did in path = [.conversation(did, focus: true)] }
                case let .conversation(did, focus):
                    ConversationView(store: store, peer: did, autofocus: focus) { path.append(.desk($0)) }.id(did)
                case let .desk(threadId):
                    DeskThreadView(store: store, threadId: threadId, archiveNext: {
                        guard let thread = store.threads.first(where: { $0.id == threadId }) else { return }
                        await store.archive(thread)
                        if store.threads.first(where: { $0.id == threadId })?.archived == true, !path.isEmpty { path.removeLast() }
                    }).id(threadId)
                }
            }
        }.tint(TUITheme.accent)
    }
    // Archiving a conversation archives (and acknowledges) each of its open threads.
    private func archive(_ conversation: Conversation) async {
        for thread in store.threads where conversation.threadIds.contains(thread.id) && !thread.archived { await store.archive(thread) }
    }
}

struct ConversationRow: View {
    let conversation: Conversation
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text("›").foregroundStyle(TUITheme.accent)
                Text(conversation.agent.name).foregroundStyle(TUITheme.fg).lineLimit(1)
                if let callsign = conversation.agent.callsign { Text(callsign).foregroundStyle(TUITheme.teal).lineLimit(1) }
                Spacer(minLength: 4)
                if let date = conversation.latest?.date { Text(shortTime(date)).font(TUITheme.microFont).foregroundStyle(TUITheme.dim) }
            }
            if let latest = conversation.latest {
                Text((latest.outgoing ? "YOU: " : "") + InboxThread.firstLine(latest.text)).foregroundStyle(TUITheme.dim).lineLimit(1)
            }
            let status = [conversation.agent.project, conversation.latest?.receipt.uppercased(), conversation.unread > 0 ? "\(conversation.unread) UNREAD" : nil, conversation.needsAnswer ? "NEEDS ANSWER" : nil].compactMap { $0 }
            Text(status.joined(separator: " / ")).font(TUITheme.microFont).foregroundStyle(conversation.unread > 0 || conversation.needsAnswer ? TUITheme.teal : TUITheme.dim).lineLimit(1)
        }
    }
}
func shortTime(_ date: Date, now: Date = Date()) -> String {
    Calendar.current.isDate(date, inSameDayAs: now) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(date: .numeric, time: .omitted)
}

struct TerminalFilterBar: View {
    @Binding var filter: ListFilter
    let projects: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                ForEach(ListScope.allCases) { scope in
                    Button(filter.scope == scope ? "[" + scope.rawValue + "]" : scope.rawValue) { filter.scope = scope }
                        .foregroundStyle(filter.scope == scope ? TUITheme.accent : TUITheme.dim)
                        .accessibilityAddTraits(filter.scope == scope ? .isSelected : [])
                }
            }.font(TUITheme.microFont).lineLimit(1).minimumScaleFactor(0.7)
            HStack(spacing: 8) {
                Menu {
                    Button("all projects") { filter.project = nil }
                    ForEach(Array(Set(projects + [filter.project].compactMap { $0 })).sorted(), id: \.self) { project in Button(project) { filter.project = project } }
                } label: { Text("[" + (filter.project ?? "all projects") + "]").foregroundStyle(filter.project == nil ? TUITheme.dim : TUITheme.accent).lineLimit(1) }
                TextField("", text: $filter.query, prompt: Text("search").foregroundStyle(TUITheme.dim))
                    .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                    .padding(6).background(TUITheme.panel).overlay(Rectangle().stroke(TUITheme.grid, lineWidth: 1)).accessibilityIdentifier("list-search")
                if !filter.query.isEmpty { Button("[x]") { filter.query = "" }.foregroundStyle(TUITheme.accent) }
            }.font(TUITheme.microFont)
        }.padding(.vertical, 4)
    }
}

struct AgentPickerView: View {
    let directory: AgentDirectory
    let pick: (String) -> Void
    @State private var query = ""
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                Text("[NEW MESSAGE / PICK AN AGENT]").foregroundStyle(TUITheme.accent).padding(.vertical, 8)
                TerminalHints(text: "tap → open conversation · edge swipe → back")
                TextField("", text: $query, prompt: Text("search name, callsign, project").foregroundStyle(TUITheme.dim))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(6).background(TUITheme.panel).overlay(Rectangle().stroke(TUITheme.grid, lineWidth: 1)).accessibilityIdentifier("agent-search")
                let shown = directory.matching(query)
                if !shown.recent.isEmpty {
                    Text("RECENT").font(TUITheme.microFont).foregroundStyle(TUITheme.dim).padding(.top, 6)
                    ForEach(shown.recent) { agent in row(agent) }
                }
                Text("ALL AGENTS / \(shown.all.count)").font(TUITheme.microFont).foregroundStyle(TUITheme.dim).padding(.top, 6)
                if shown.all.isEmpty { Text(directory.all.isEmpty ? "No known agents yet. Peers appear after sign-in." : "No agent matches.").foregroundStyle(TUITheme.dim) }
                ForEach(shown.all) { agent in row(agent) }
            }.padding(8)
        }.background(TUITheme.bg).toolbar(.visible, for: .navigationBar).toolbarBackground(TUITheme.bg, for: .navigationBar)
    }
    private func row(_ agent: AgentIdentity) -> some View {
        Button { pick(agent.did) } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("›").foregroundStyle(TUITheme.accent)
                    Text(agent.name).foregroundStyle(TUITheme.fg).lineLimit(1)
                    if let callsign = agent.callsign { Text(callsign).foregroundStyle(TUITheme.teal).lineLimit(1) }
                }
                Text(agent.project ?? "no project").font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8).background(TUITheme.panel)
        }.buttonStyle(.plain).accessibilityIdentifier("agent-" + agent.name)
    }
}

struct ConversationView: View {
    let store: InboxStore; let peer: String; let autofocus: Bool
    let openDesk: (String) -> Void
    @State private var chosen: String?
    @State private var fresh = false
    var body: some View {
        let conversation = store.conversations.first { $0.id == peer }
        let agent = conversation?.agent ?? AgentIdentity(did: peer, callsign: store.callsignsBySender[peer])
        let entries = conversation?.entries ?? []
        // Reply to the chosen message, else the latest incoming one; [x] sends fresh.
        let targetId = fresh ? nil : chosen ?? entries.last { !$0.outgoing && $0.mailId != nil }?.mailId
        let target = targetId.flatMap { id in store.messages.first { $0.id == id } }
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(agent.name).font(TUITheme.titleFont).foregroundStyle(TUITheme.accent)
                        if let callsign = agent.callsign { Text(callsign).foregroundStyle(TUITheme.teal) }
                        Text(agent.project.map { "PROJECT " + $0 } ?? "NO PROJECT").font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
                        Text(peer).font(TUITheme.microFont).foregroundStyle(TUITheme.dim).textSelection(.enabled)
                    }
                    TerminalHints(text: "edge swipe → back · [reply] → answer that message")
                    if entries.isEmpty { Text("No messages yet.").foregroundStyle(TUITheme.dim) }
                    ForEach(entries) { entry in
                        ConversationEntryView(entry: entry, agent: agent, parent: entry.parentId.flatMap { id in entries.first { $0.id == id } },
                            thread: { id in store.threads.first { $0.id == id } }, openDesk: openDesk,
                            reply: entry.mailId.map { id in { chosen = id; fresh = false } },
                            acknowledge: entry.mailId.flatMap { id in store.messages.first { $0.id == id } }.map { item in { Task { await store.acknowledge(item) } } },
                            canAcknowledge: store.state == .live)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(8)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: entries.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) {
            ConversationComposer(store: store, peer: peer, name: agent.name, target: target, autofocus: autofocus) { chosen = nil; fresh = true }
        }
        .background(TUITheme.bg).toolbar(.visible, for: .navigationBar).toolbarBackground(TUITheme.bg, for: .navigationBar)
    }
}

struct ConversationEntryView: View {
    let entry: ConversationEntry; let agent: AgentIdentity; let parent: ConversationEntry?
    let thread: (String) -> InboxThread?
    let openDesk: (String) -> Void
    let reply: (() -> Void)?
    let acknowledge: (() -> Void)?
    let canAcknowledge: Bool
    var body: some View {
        TerminalPanel(title: title) {
            if let parent {
                Text(quote(parent)).font(TUITheme.microFont).foregroundStyle(TUITheme.dim).lineLimit(1)
            }
            switch entry.kind {
            case let .desk(threadId):
                let desk = thread(threadId)
                Text(deskLabel(desk)).font(TUITheme.microFont).foregroundStyle(TUITheme.warn)
                Text(entry.text).foregroundStyle(TUITheme.fg)
                if let why = desk?.card?.why { Text(why).foregroundStyle(TUITheme.dim) }
                if !threadId.isEmpty { Button("[open desk item]") { openDesk(threadId) }.foregroundStyle(TUITheme.accent) }
            case .sealed:
                Text(entry.text).foregroundStyle(TUITheme.dim)
            default:
                Text(entry.text).foregroundStyle(TUITheme.fg).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if !entry.outgoing, reply != nil || acknowledge != nil {
                HStack(spacing: 12) {
                    if let reply { Button("[reply]") { reply() }.foregroundStyle(TUITheme.accent) }
                    if let acknowledge, entry.receipt == "delivered" { Button("[ACK READ]") { acknowledge() }.disabled(!canAcknowledge).foregroundStyle(TUITheme.accent) }
                }.font(TUITheme.microFont)
            }
        }
        .padding(.leading, CGFloat(min(entry.depth, 3)) * 12)
        .overlay(alignment: .leading) { if entry.depth > 0 { Rectangle().fill(TUITheme.grid).frame(width: 1) } }
    }
    private var title: String {
        let who = entry.outgoing ? "YOU" : entry.label ?? agent.name
        let when = entry.date.map { $0.formatted(date: Calendar.current.isDateInToday($0) ? .omitted : .numeric, time: .shortened) } ?? ""
        return [who, when, entry.receipt.uppercased()].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private func quote(_ parent: ConversationEntry) -> String {
        let who = parent.outgoing ? "YOU" : parent.label ?? agent.name
        return "↳ re " + who + ": " + InboxThread.firstLine(parent.text)
    }
    private func deskLabel(_ desk: InboxThread?) -> String {
        let kind = desk?.card?.kind.uppercased() ?? "ITEM", state = desk?.state.rawValue.uppercased() ?? "OPEN"
        return "DESK " + kind + " / " + state
    }
}

struct ConversationComposer: View {
    let store: InboxStore; let peer: String; let name: String
    let target: MailItem?
    let autofocus: Bool
    let clearTarget: () -> Void
    @State private var text = ""
    @FocusState private var focused: Bool
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ThinDivider()
            if let target {
                HStack {
                    Text("↳ replying to: " + InboxThread.firstLine(MessageText(target.text).text)).font(TUITheme.microFont).foregroundStyle(TUITheme.dim).lineLimit(1)
                    Spacer()
                    Button("[x new]") { clearTarget() }.font(TUITheme.microFont).foregroundStyle(TUITheme.accent)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("", text: $text, prompt: Text("message " + name).foregroundStyle(TUITheme.dim), axis: .vertical)
                    .lineLimit(1...5).focused($focused).padding(8).background(TUITheme.panel)
                    .overlay(Rectangle().stroke(focused ? TUITheme.accent : TUITheme.grid, lineWidth: 1))
                    .accessibilityIdentifier("conversation-composer")
                Button(store.hasPendingSend ? "[RETRY]" : "[SEND]") {
                    Task {
                        if store.hasPendingSend { await store.send(to: "", text: "") }
                        else if let target { await store.reply(to: target, text: text) }
                        else { await store.send(to: peer, text: text) }
                        if !store.hasPendingSend, store.lastError == nil { text = "" }
                    }
                }.disabled(store.state != .live || store.sending || (!store.hasPendingSend && text.isEmpty)).foregroundStyle(TUITheme.accent).padding(.vertical, 8)
            }
            Text(store.hasPendingSend ? "Saved send pending. Retry uses the same envelope, not this draft." : "Signed plaintext from this phone. Not encrypted.")
                .font(TUITheme.microFont).foregroundStyle(TUITheme.warn)
            if let error = store.lastError { Text("! " + error).font(TUITheme.microFont).foregroundStyle(TUITheme.err) }
        }.padding(8).background(TUITheme.bg)
        .task {
            // Focus after the push settles; an early focus is dropped by the transition.
            guard autofocus else { return }
            try? await Task.sleep(for: .milliseconds(450)); focused = true
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { text = "" } }
    }
}
