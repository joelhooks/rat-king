import SwiftUI
import UIKit

// Message Fold, after pi-ratking's compactLines: a collapsed card is at most four
// lines. Line one is the sender with its markers, which never truncate away; then
// the summary, else the wrapped body. A clipped card ends `… +N lines`, where N
// counts every wrapped line not fully shown, including a body behind its summary.
// Late Paint: the layout is plain strings per column width; styling happens at render.
struct MessageFold: Equatable {
    static let cap = 4
    let heading: String
    let lines: [String]
    let hidden: Int
    var folds: Bool { hidden > 0 }

    init(sender: String, markers: [String], summary: String?, body: String, width: Int) {
        let width = max(1, width)
        let markerText = markers.map { " · " + $0 }.joined()
        heading = Self.clip(sender, to: max(1, width - markerText.count)) + markerText
        let summary = summary.map(MessageText.oneLine).flatMap { $0.isEmpty ? nil : $0 }
        let bodyLines = Self.wrap(body, width: width)
        let content = summary.map { Self.wrap($0, width: width) } ?? bodyLines
        // A body that only repeats its summary hides nothing.
        let behind = summary == nil || MessageText.oneLine(body) == summary ? 0 : bodyLines.count
        let room = Self.cap - 1
        guard content.count > room || behind > 0 else { lines = content; hidden = 0; return }
        var shown = Array(content.prefix(room))
        var count = content.count - shown.count + behind
        if shown.count < room {
            lines = shown + [Self.more(count).trimmingCharacters(in: .whitespaces)]; hidden = count; return
        }
        let last = shown.removeLast()
        if last.count + Self.more(count).count > width { count += 1 }
        let suffix = Self.more(count)
        lines = shown + [(last.count + suffix.count <= width ? last : Self.clip(last, to: max(0, width - suffix.count), mark: "")) + suffix]
        hidden = count
    }

    static func more(_ count: Int) -> String { " … +\(count) line" + (count == 1 ? "" : "s") }

    static func clip(_ text: String, to width: Int, mark: String = "…") -> String {
        guard text.count > width else { return text }
        guard width > mark.count else { return String(text.prefix(width)) }
        return String(text.prefix(width - mark.count)) + mark
    }

    // Word wrap at a column width; words longer than the width break mid-word.
    static func wrap(_ text: String, width: Int) -> [String] {
        let width = max(1, width)
        var result: [String] = []
        for raw in text.replacingOccurrences(of: "\r", with: "").split(whereSeparator: \.isNewline) {
            let paragraph = raw.replacingOccurrences(of: "\t", with: " ").trimmingCharacters(in: .whitespaces)
            guard !paragraph.isEmpty else { continue }
            var line = ""
            for word in paragraph.split(separator: " ") {
                var word = Substring(word)
                if !line.isEmpty, line.count + 1 + word.count <= width { line += " " + word; continue }
                if !line.isEmpty { result.append(line); line = "" }
                while word.count > width { result.append(String(word.prefix(width))); word = word.dropFirst(width) }
                line = String(word)
            }
            if !line.isEmpty { result.append(line) }
        }
        return result
    }
}

// Native card for one message. Tap folds and unfolds in place; expanded shows
// `Summary:` above the full body. The column width comes from the pixel font.
struct MessageFoldView: View {
    let sender: String
    var markers: [String] = []
    let summary: String?
    let text: String
    var quote: String?
    @State private var expanded = false
    @State private var columns = 40
    var body: some View {
        let fold = MessageFold(sender: sender, markers: markers, summary: summary, body: text, width: columns)
        let unit = FontBook.columnWidth
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 0) {
                Text("─ " + sender).lineLimit(1).truncationMode(.tail)
                Text(markers.map { " · " + $0 }.joined()).lineLimit(1).fixedSize()
                ThinDivider().padding(.leading, 8)
            }.font(TUITheme.microFontBold).foregroundStyle(TUITheme.accent)
            if expanded {
                if let quote { Text(quote).font(TUITheme.microFont).foregroundStyle(TUITheme.dim) }
                if let summary, MessageText.oneLine(text) != summary {
                    Text("Summary: " + summary).foregroundStyle(TUITheme.teal).fixedSize(horizontal: false, vertical: true)
                }
                Text(text).foregroundStyle(TUITheme.fg).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Text("[− fold]").font(TUITheme.microFont).foregroundStyle(TUITheme.accent)
            } else {
                ForEach(Array(fold.lines.enumerated()), id: \.offset) { index, line in
                    Text(line).lineLimit(1).truncationMode(.tail)
                        .foregroundStyle(index == fold.lines.count - 1 && fold.folds ? TUITheme.dim : TUITheme.fg)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { if fold.folds || expanded { expanded.toggle() } }
        .onGeometryChange(for: Int.self) { proxy in Int(proxy.size.width / unit) } action: { columns = max(1, $0) }
        .accessibilityElement(children: .combine)
        .accessibilityHint(fold.folds ? (expanded ? "Tap to fold" : "Tap to show the full message") : "")
    }
}
