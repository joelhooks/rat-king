import SwiftUI

struct DeskInboxView: View {
    let store: InboxStore
    let reply: (String) -> Void
    @State private var archived = false
    @State private var snoozing: InboxThread?
    var body: some View {
        NavigationStack {
            List {
                Button(archived ? "[INBOX]" : "[ARCHIVED]") { archived.toggle() }.foregroundStyle(TUITheme.accent).listRowBackground(TUITheme.panel)
                let threads = store.threads.filter { $0.visible(at: store.now, archivedView: archived) }
                if threads.isEmpty { Text(archived ? "No archived threads." : "Waiting for encrypted mail.\nKeep the app open to sync.").foregroundStyle(TUITheme.dim).listRowBackground(TUITheme.panel) }
                ForEach(Array(Set(threads.map(\.project))).sorted(), id: \.self) { project in
                    Section(project) {
                        ForEach(threads.filter { $0.project == project }) { thread in
                            NavigationLink {
                                DeskThreadView(store: store, threadId: thread.id, reply: reply)
                            } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(thread.title).foregroundStyle(TUITheme.teal)
                                    Text(thread.state.rawValue.uppercased() + " / \(thread.mailIds.count) MAIL").foregroundStyle(TUITheme.dim).font(TUITheme.microFont)
                                }.padding(.vertical, 8)
                            }.listRowBackground(TUITheme.panel)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                if archived { Button("UNDO") { store.restore(thread) }.tint(TUITheme.accent) }
                                else {
                                    Button("ARCHIVE") { Task { await store.archive(thread) } }.tint(TUITheme.dim).disabled(store.state != .live)
                                    if thread.state == .open || thread.state == .sent { Button("SNOOZE") { snoozing = thread }.tint(TUITheme.warn) }
                                }
                            }
                        }
                    }
                }
            }.listStyle(.plain).scrollContentBackground(.hidden).background(TUITheme.bg)
            .toolbar(.hidden, for: .navigationBar)
            .confirmationDialog("Snooze on this phone only", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }), titleVisibility: .visible) {
                ForEach(SnoozeChoice.allCases) { choice in
                    Button(choice.rawValue) { if let thread = snoozing { Task { await store.snooze(thread, choice: choice) } }; snoozing = nil }
                }
                Button("CANCEL", role: .cancel) { snoozing = nil }
            }
        }.tint(TUITheme.accent)
    }
}
struct DeskThreadView: View {
    let store: InboxStore; let threadId: String; let reply: (String) -> Void
    @State private var values: [String: String] = [:]
    @State private var rows: [String: [String]] = [:]
    @State private var note = ""
    @Environment(\.dismiss) private var dismiss
    private var thread: InboxThread? { store.threads.first { $0.id == threadId } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Button("[BACK]") { dismiss() }.foregroundStyle(TUITheme.accent)
                if let thread {
                    Text(thread.project + " / " + thread.state.rawValue.uppercased()).foregroundStyle(TUITheme.dim)
                    Text("FROM " + thread.sender).foregroundStyle(TUITheme.teal).textSelection(.enabled)
                    if let card = thread.card {
                        Text(card.title).font(TUITheme.titleFont).foregroundStyle(TUITheme.accent)
                        Text(card.why).foregroundStyle(TUITheme.warn)
                        Text(card.body).textSelection(.enabled)
                        ForEach(card.choices) { axis in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(axis.label).foregroundStyle(TUITheme.teal)
                                ForEach(axis.options) { option in
                                    Button { values[axis.id] = option.id } label: {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text((values[axis.id] == option.id ? "[x] " : "[ ] ") + option.label + (axis.suggest == option.id ? " (suggested)" : ""))
                                            Text("then: " + option.outcome).foregroundStyle(TUITheme.dim)
                                        }.frame(maxWidth: .infinity, alignment: .leading).padding(10).background(TUITheme.panel)
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
                            TextEditor(text: $note).font(TUITheme.monoFont).scrollContentBackground(.hidden).frame(minHeight: 100).padding(8).background(TUITheme.panel)
                            Button("[SEAL + SEND ANSWER]") { Task { await store.answer(thread, values: values, rows: rows, note: note) } }
                                .disabled(store.state != .live || store.sending || store.hasPendingSend).foregroundStyle(TUITheme.accent)
                            if store.hasPendingSend { Text("A sealed send is pending. Retry it from Compose before answering another item.").foregroundStyle(TUITheme.warn) }
                        }
                    } else {
                        Button("[REPLY]") { reply(thread.sender); dismiss() }.foregroundStyle(TUITheme.accent)
                    }
                    ForEach(Array(thread.lines.enumerated()), id: \.offset) { _, line in Text(line).textSelection(.enabled) }
                    ForEach(store.messages.filter { thread.mailIds.contains($0.id) }) { item in
                        HStack {
                            Text(item.receipt.uppercased()).foregroundStyle(TUITheme.dim)
                            if item.receipt == "delivered" { Button("[ACK READ]") { Task { await store.acknowledge(item) } }.disabled(store.state != .live).foregroundStyle(TUITheme.accent) }
                        }
                    }
                }
            }.padding(12)
        }.background(TUITheme.bg).toolbar(.hidden, for: .navigationBar)
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
