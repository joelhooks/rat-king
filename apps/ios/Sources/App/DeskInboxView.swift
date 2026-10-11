import SwiftUI

struct DeskInboxView: View {
    let store: InboxStore
    @Binding var filter: ListFilter
    private var archived: Bool { filter.scope == .archived }
    @State private var snoozing: InboxThread?
    @State private var path: [String] = []
    var body: some View {
        NavigationStack(path: $path) {
            ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(archived ? "[ARCHIVED]" : "[INBOX]").foregroundStyle(TUITheme.accent)
                        Spacer()
                    }.padding(.vertical, 8)
                    TerminalHints(text: archived ? "tap → thread · swipe right → restore" : "tap → thread · ← archive · snooze →")
                    TerminalFilterBar(filter: $filter, projects: store.presentedThreads.flatMap { threadFacts($0, unread: 0, callsign: nil).projects })
                    Color.clear.frame(height: 1).id("top")
                    if store.presentation.loading {
                        Text("loading \(store.presentation.progress)…").foregroundStyle(TUITheme.warn).accessibilityIdentifier("inbox-loading")
                    } else {
                    if !store.presentation.pending.isEmpty {
                        Button("[\(store.presentation.pending.count) new ↑]") { store.revealNew(); proxy.scrollTo("top", anchor: .top) }.foregroundStyle(TUITheme.accent)
                    }
                    let threads = visibleThreads
                    if threads.isEmpty { Text(archived ? "No archived threads." : filter == ListFilter() ? "Waiting for encrypted mail. Keep the app open to sync." : "Nothing matches this filter.").foregroundStyle(TUITheme.dim) }
                    ForEach(Array(Set(threads.map(\.project))).sorted(), id: \.self) { project in
                        Text(project.uppercased()).foregroundStyle(TUITheme.dim).font(TUITheme.microFont).padding(.top, 4)
                        ForEach(threads.filter { $0.project == project }) { thread in
                            TerminalSwipeRow(archiveLabel: "[ARCHIVE]", snoozeLabel: archived ? "[RESTORE]" : "[SNOOZE]",
                                canArchive: canArchiveThread(thread, connection: store.state), canSnooze: archived || thread.state == .open || thread.state == .sent,
                                archive: { Task { await store.archive(thread) } },
                                snooze: { if archived { store.restore(thread) } else { snoozing = thread } },
                                open: { path.append(thread.id) }) {
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 6) {
                                        Text("›").foregroundStyle(TUITheme.accent)
                                        Text(thread.summary).foregroundStyle(TUITheme.fg).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    let unread = store.messages.filter { thread.mailIds.contains($0.id) && $0.outgoingTo == nil && $0.receipt == "delivered" }.count
                                    Text(thread.state.rawValue.uppercased() + " / \(thread.mailIds.count) MAIL" + (unread > 0 ? " / \(unread) UNREAD" : " / NO UNREAD")).foregroundStyle(unread > 0 ? TUITheme.teal : TUITheme.dim).font(TUITheme.microFont)
                                }
                            }
                        }
                    }
                    }
                }.padding(8)
            }.refreshable { store.refresh() }
            }
            .background(TUITheme.bg).toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { threadId in
                DeskThreadView(store: store, threadId: threadId, archiveNext: {
                    guard let thread = store.threads.first(where: { $0.id == threadId }) else { return }
                    let next = nextInboxID(after: threadId, in: visibleThreads.map(\.id))
                    await store.archive(thread)
                    guard store.threads.first(where: { $0.id == threadId })?.archived == true else { return }
                    if let next { path = [next] } else { path = [] }
                }).id(threadId)
            }
            .overlay {
                if let thread = snoozing {
                    ZStack {
                        Color.black.opacity(0.75).ignoresSafeArea().onTapGesture { snoozing = nil }
                        TerminalPanel(title: "SNOOZE / PHONE ONLY") {
                            Text(thread.title).foregroundStyle(TUITheme.dim).lineLimit(1)
                            ThinDivider()
                            ForEach(SnoozeChoice.allCases) { choice in
                                Button("[" + choice.rawValue + "]") { Task { await store.snooze(thread, choice: choice) }; snoozing = nil }
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6).foregroundStyle(TUITheme.fg)
                            }
                            ThinDivider()
                            Button("[CANCEL]") { snoozing = nil }.foregroundStyle(TUITheme.accent).padding(.vertical, 6)
                        }.font(TUITheme.monoFont).padding(20)
                    }
                }
            }
        }.tint(TUITheme.accent)
    }
    private var visibleThreads: [InboxThread] {
        let names = store.callsignsBySender
        let unread = Dictionary(store.messages.filter { $0.outgoingTo == nil && $0.receipt == "delivered" }.map { ($0.id, 1) }, uniquingKeysWith: +)
        let threads = store.presentedThreads.filter {
            $0.visible(at: store.now, archivedView: archived) && filter.admits(threadFacts($0, unread: $0.mailIds.reduce(0) { $0 + (unread[$1] ?? 0) }, callsign: names[$0.sender]))
        }
        return Array(Set(threads.map(\.project))).sorted().flatMap { project in threads.filter { $0.project == project } }
    }
}
struct DeskThreadView: View {
    let store: InboxStore; let threadId: String; let archiveNext: () async -> Void
    @State private var values: [String: String] = [:]
    @State private var rows: [String: [String]] = [:]
    @State private var note = ""
    @Environment(\.dismiss) private var dismiss
    private var thread: InboxThread? { store.threads.first { $0.id == threadId } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Button("[BACK]") { dismiss() }.foregroundStyle(TUITheme.accent)
                if let thread {
                    HStack {
                        Text(thread.project + " / " + thread.state.rawValue.uppercased()).foregroundStyle(TUITheme.dim)
                        Spacer()
                        Button("[ARCHIVE + NEXT]") { Task { await archiveNext() } }.disabled(!canArchiveThread(thread, connection: store.state)).foregroundStyle(TUITheme.accent).accessibilityIdentifier("archive-next")
                    }
                    Text("FROM " + thread.sender).foregroundStyle(TUITheme.teal).textSelection(.enabled)
                    if let card = thread.card {
                        Text(card.title).font(TUITheme.titleFont).foregroundStyle(TUITheme.accent)
                        Text(card.why).foregroundStyle(TUITheme.warn)
                        TerminalMessage(text: card.body)
                        ForEach(card.choices) { axis in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(axis.label).foregroundStyle(TUITheme.teal)
                                ForEach(axis.options) { option in
                                    Button { values[axis.id] = option.id } label: {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text((values[axis.id] == option.id ? "[x] " : "[ ] ") + option.label + (axis.suggest == option.id ? " (suggested)" : ""))
                                            Text("then: " + option.outcome).foregroundStyle(TUITheme.dim)
                                        }.frame(maxWidth: .infinity, alignment: .leading).padding(10).background(TUITheme.panel)
                                            .overlay(Rectangle().stroke(values[axis.id] == option.id ? TUITheme.accent : TUITheme.grid, lineWidth: 1))
                                    }.foregroundStyle(TUITheme.fg).disabled(thread.state != .open)
                                }
                            }
                        }
                        if let group = card.rows {
                            Text(group.label).foregroundStyle(TUITheme.teal)
                            ForEach(group.items) { row in
                                Button {
                                    var selected = rows[group.key] ?? []
                                    if selected.contains(row.id) { selected.removeAll { $0 == row.id } } else { selected.append(row.id) }
                                    rows[group.key] = selected
                                } label: { Text((rows[group.key]?.contains(row.id) == true ? "[x] " : "[ ] ") + row.label) }.foregroundStyle(TUITheme.fg).disabled(thread.state != .open)
                            }
                        }
                        if !card.refs.isEmpty { Text("REFS: " + card.refs.joined(separator: " / ")).foregroundStyle(TUITheme.dim) }
                        if thread.state != .open, let saved = store.preferences[thread.id]?.answer, let sentNote = try? saved["note"]?.text { Text("SENT NOTE: " + sentNote).foregroundStyle(TUITheme.dim) }
                        if thread.state == .open {
                            Text("NOTE (overrides ticks if they conflict)").foregroundStyle(TUITheme.dim)
                            TextEditor(text: $note).font(TUITheme.monoFont).scrollContentBackground(.hidden).frame(minHeight: 64).padding(6).background(TUITheme.panel)
                            Button("[SEAL + SEND ANSWER]") { Task { await store.answer(thread, values: values, rows: rows, note: note) } }
                                .disabled(store.state != .live || store.sending || store.hasPendingSend).foregroundStyle(TUITheme.accent)
                            if store.hasPendingSend { Text("A sealed send is pending. Retry it from Chats before answering another item.").foregroundStyle(TUITheme.warn) }
                        }
                    }
                    if let target = store.messages.last(where: { thread.mailIds.contains($0.id) && $0.outgoingTo == nil }) {
                        ReplyComposer(store: store, target: target).id(target.id)
                    }
                    ForEach(Array(thread.lines.enumerated()), id: \.offset) { _, line in TerminalMessage(text: line) }
                    ForEach(store.messages.filter { thread.mailIds.contains($0.id) }) { item in
                        HStack {
                            Text(item.receipt.uppercased()).foregroundStyle(TUITheme.dim)
                            if item.outgoingTo == nil && item.receipt == "delivered" { Button("[ACK READ]") { Task { await store.acknowledge(item) } }.disabled(store.state != .live).foregroundStyle(TUITheme.accent) }
                        }
                    }
                }
            }.padding(8)
        }.background(TUITheme.bg).toolbar(.visible, for: .navigationBar)
        .toolbarBackground(TUITheme.bg, for: .navigationBar)
        .task {
            guard let card = thread?.card else { return }
            values = Dictionary(uniqueKeysWithValues: card.choices.map { ($0.id, $0.suggest) })
            if let group = card.rows { rows[group.key] = group.items.filter(\.on).map(\.id) }
            if let saved = store.preferences[threadId]?.answer {
                if let sentValues = try? saved.required("values").object().mapValues({ try $0.text }) { values = sentValues }
                if let sentRows = try? saved["rows"]?.object().mapValues({ try $0.list().map { try $0.text } }) { rows = sentRows }
            }
        }
    }
}
