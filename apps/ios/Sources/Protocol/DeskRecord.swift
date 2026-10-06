import Foundation

// Lossless wire value plus validated native projection. Unknown fields survive a
// round trip; known desk tags never fall back to plain chat on validation failure.
struct DeskOption: Identifiable, Equatable { let id: String; let label: String; let outcome: String }
struct DeskChoice: Identifiable, Equatable { let id: String; let label: String; let suggest: String; let options: [DeskOption] }
struct DeskRow: Identifiable, Equatable { let id: String; let label: String; let on: Bool }
struct DeskRows: Equatable { let key: String; let label: String; let items: [DeskRow] }
struct DeskCard: Equatable {
    let project: String; let itemId: String; let kind: String; let title: String; let why: String; let body: String
    let choices: [DeskChoice]; let rows: DeskRows?; let refs: [String]; let supersedes: String?
}
enum DeskRecord: Equatable {
    static let namespace = "sh.mschf.ratking.desk."
    case item(Value, DeskCard), answer(Value), update(Value, String, String, String, String?)
    var value: Value { switch self { case let .item(v, _), let .answer(v), let .update(v, _, _, _, _): return v } }
    static func decode(_ value: Value) throws -> DeskRecord? {
        guard case let .string(tag)? = value["$type"], [namespace + "item", namespace + "answer", namespace + "update"].contains(tag) else { return nil }
        let project = try value.required("project").text, itemId = try value.required("itemId").text
        switch tag {
        case namespace + "item":
            let kind = try value.required("kind").text
            guard ["decision", "approval", "blocked", "done", "fyi"].contains(kind) else { throw ProtocolError.invalid("Unknown desk item kind") }
            let created = try value.required("createdAt").text
            let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard fractional.date(from: created) != nil || ISO8601DateFormatter().date(from: created) != nil else { throw ProtocolError.invalid("Invalid desk date") }
            let choices = try value.required("choices").list().map { axis in
                let options = try axis.required("options").list().map { option in
                    DeskOption(id: try option.required("id").text, label: try option.required("label").text, outcome: try option.required("outcome").text)
                }
                let suggest = try axis.required("suggest").text
                guard !options.isEmpty, Set(options.map(\.id)).count == options.count, options.contains(where: { $0.id == suggest }) else { throw ProtocolError.invalid("Invalid desk options or suggestion") }
                return DeskChoice(id: try axis.required("key").text, label: try axis.required("label").text, suggest: suggest, options: options)
            }
            guard Set(choices.map(\.id)).count == choices.count else { throw ProtocolError.invalid("Duplicate desk axis") }
            let rows = try value["rows"].map { group in
                let items = try group.required("items").list().map { row in
                    guard case let .bool(on) = try row.required("on") else { throw ProtocolError.invalid("Invalid desk row toggle") }
                    return DeskRow(id: try row.required("v").text, label: try row.required("label").text, on: on)
                }
                let key = try group.required("key").text
                guard Set(items.map(\.id)).count == items.count, !choices.contains(where: { $0.id == key }) else { throw ProtocolError.invalid("Duplicate desk row key") }
                return DeskRows(key: key, label: try group.required("label").text, items: items)
            }
            return .item(value, DeskCard(project: project, itemId: itemId, kind: kind, title: try value.required("title").text, why: try value.required("why").text, body: try value.required("body").text, choices: choices, rows: rows, refs: try value.required("refs").list().map { try $0.text }, supersedes: try value["supersedes"]?.text))
        case namespace + "answer":
            let tid = try value.required("inReplyTo").text
            guard tid.count == 13, tid.first.map({ "234567abcdefghij".contains($0) }) == true, tid.allSatisfy({ "234567abcdefghijklmnopqrstuvwxyz".contains($0) }) else { throw ProtocolError.invalid("Invalid reply message tid") }
            for option in try value.required("values").object().values { _ = try option.text }
            if let rows = value["rows"] { for row in try rows.object().values { for option in try row.list() { _ = try option.text } } }
            _ = try value["note"]?.text
            return .answer(value)
        default:
            let state = try value.required("state").text
            guard ["resolved", "superseded", "followup"].contains(state) else { throw ProtocolError.invalid("Unknown desk update state") }
            return .update(value, project, itemId, state, try value["text"]?.text)
        }
    }
    static func answer(card: DeskCard, inReplyTo: String, values: [String: String], rows: [String: [String]], note: String) throws -> Value {
        guard Set(values.keys) == Set(card.choices.map(\.id)), card.choices.allSatisfy({ axis in axis.options.contains(where: { $0.id == values[axis.id] }) }) else { throw ProtocolError.invalid("Choose one option per axis") }
        if let group = card.rows {
            guard Set(rows.keys) == [group.key], Set(rows[group.key] ?? []).isSubset(of: Set(group.items.map(\.id))) else { throw ProtocolError.invalid("Invalid row selection") }
        } else if !rows.isEmpty { throw ProtocolError.invalid("Unexpected row selection") }
        var answer: [String: Value] = ["$type": .string(namespace + "answer"), "project": .string(card.project), "itemId": .string(card.itemId), "inReplyTo": .string(inReplyTo), "values": .map(values.mapValues(Value.string))]
        if !rows.isEmpty { answer["rows"] = .map(rows.mapValues { .array($0.map(Value.string)) }) }
        if !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { answer["note"] = .string(note) }
        let value = Value.map(answer); _ = try decode(value); return value
    }
}
