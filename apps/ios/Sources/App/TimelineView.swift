import SwiftUI

struct TimelinePost: Identifiable, Equatable {
    let agent: AgentIdentity
    let entry: ConversationEntry
    let needsAnswer: Bool
    var id: String { entry.id }

    static func project(_ conversations: [Conversation], needingAnswer: Set<String>) -> [Self] {
        conversations.flatMap { conversation in
            conversation.entries.filter { $0.mailId != nil }.map { entry in
                let needsAnswer = if case let .desk(thread) = entry.kind { needingAnswer.contains(thread) } else { false }
                return Self(agent: conversation.agent, entry: entry, needsAnswer: needsAnswer)
            }
        }.sorted { left, right in
            let a = left.entry.date ?? .distantPast
            let b = right.entry.date ?? .distantPast
            return a == b ? left.id > right.id : a > b
        }
    }
}

private struct TimelineSelection: Equatable {
    let peer: String
    let post: String?
}

private enum TimelineSheet: Identifiable {
    case compose, desk(String)
    var id: String {
        switch self { case .compose: "compose"; case let .desk(id): "desk:" + id }
    }
}

struct TimelineView: View {
    let store: InboxStore
    @State private var selection: TimelineSelection?
    @State private var showThread = false
    @State private var sheet: TimelineSheet?
    @State private var history = InboxHistoryScroll()
    @State private var visiblePost: String?
    @State private var threadAnchor: String?
    @State private var needsAnswer = false
    @State private var query = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("TIMELINE").foregroundStyle(TUITheme.accent)
                Spacer()
                Button("Compose") { sheet = .compose }.frame(minHeight: 44).accessibilityIdentifier("timeline-compose")
            }.padding(.horizontal, 8)
            ThinDivider()
            GeometryReader { proxy in
                let wide = proxy.size.width >= 600
                let left = wide ? max(240, proxy.size.width * 0.36) : proxy.size.width
                ZStack(alignment: .topLeading) {
                    feed.frame(width: left)
                        .opacity(wide || !showThread ? 1 : 0)
                        .allowsHitTesting(wide || !showThread).accessibilityHidden(!wide && showThread)
                    detail(wide: wide).frame(width: wide ? proxy.size.width - left : proxy.size.width, height: proxy.size.height)
                        .background(alignment: .leading) { if wide { Rectangle().fill(TUITheme.dim).frame(width: 1) } }
                        .offset(x: wide ? left : 0)
                        .opacity(wide || showThread ? 1 : 0)
                        .allowsHitTesting(wide || showThread).accessibilityHidden(!wide && !showThread)
                }
            }
        }
        .background(TUITheme.bg).tint(TUITheme.accent)
        .sheet(item: $sheet) { destination in
            NavigationStack {
                switch destination {
                case .compose:
                    AgentPickerView(directory: store.agents) { did in
                        select(peer: did, post: nil)
                        sheet = nil
                    }
                case let .desk(id):
                    DeskThreadView(store: store, threadId: id, archiveNext: {
                        guard let thread = store.threads.first(where: { $0.id == id }) else { return }
                        await store.archive(thread)
                        if store.threads.first(where: { $0.id == id })?.archived == true { sheet = nil }
                    })
                }
            }.tint(TUITheme.accent)
        }
    }

    private var feed: some View {
        let posts = TimelinePost.project(store.conversations, needingAnswer: Set(store.threads.filter(threadNeedsAnswer).map(\.id)))
        let shown = posts.filter { post in
            (!needsAnswer || post.needsAnswer) && searchMatches(query, post.agent.searchFields + [post.entry.text, post.entry.preview])
        }
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                TextField("Find a message", text: $query).textFieldStyle(.roundedBorder)
                Button(needsAnswer ? "[Needs Answer]" : "Needs Answer") { needsAnswer.toggle() }
                    .frame(minHeight: 44).accessibilityAddTraits(needsAnswer ? .isSelected : [])
            }.padding(.horizontal, 8)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let notice = store.syncNotice { Text(notice).foregroundStyle(TUITheme.warn).accessibilityIdentifier("inbox-sync-notice") }
                    if shown.isEmpty && !store.presentation.loading {
                        Text(posts.isEmpty ? "No messages yet." : "No matching messages.").foregroundStyle(TUITheme.dim)
                    }
                    ForEach(shown) { post in postRow(post) }
                    InboxHistoryFooter(store: store, scroll: $history)
                }.scrollTargetLayout().padding(8)
            }.scrollPosition(id: $visiblePost, anchor: .top)
                .refreshable { store.refresh() }
                .simultaneousGesture(DragGesture().onEnded { history.drag($0, load: store.loadOlder) })
        }
    }

    private func postRow(_ post: TimelinePost) -> some View {
        Button { select(peer: post.agent.did, post: post.id) } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(post.entry.outgoing ? "You → " + post.agent.name : post.agent.callsign ?? post.agent.name)
                        .foregroundStyle(TUITheme.accent).lineLimit(1)
                    Spacer()
                    if let date = post.entry.date { Text(shortTime(date)).foregroundStyle(TUITheme.dim) }
                }.font(TUITheme.microFont)
                if post.needsAnswer { Text("NEEDS ANSWER").foregroundStyle(TUITheme.warn).font(TUITheme.microFont) }
                Text(post.entry.preview).foregroundStyle(TUITheme.fg).lineLimit(3)
            }.padding(8).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(selection?.post == post.id ? TUITheme.panel : TUITheme.bg).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(selection?.post == post.id ? .isSelected : [])
    }

    private func detail(wide: Bool) -> some View {
        VStack(spacing: 0) {
            Button("‹ Timeline") { showThread = false }.frame(maxWidth: .infinity, minHeight: wide ? 0 : 44, alignment: .leading)
                .padding(.horizontal, 8).frame(height: wide ? 0 : 44).clipped()
                .opacity(wide ? 0 : 1).accessibilityHidden(wide).allowsHitTesting(!wide)
            if let selection {
                ConversationView(store: store, peer: selection.peer, autofocus: selection.post == nil,
                                 timelineAnchor: $threadAnchor, composerVisible: wide || showThread) { sheet = .desk($0) }.id(selection.peer)
            } else {
                Text("Choose a message").foregroundStyle(TUITheme.dim).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func select(peer: String, post: String?) {
        selection = TimelineSelection(peer: peer, post: post)
        threadAnchor = post ?? "bottom"
        showThread = true
    }
}
