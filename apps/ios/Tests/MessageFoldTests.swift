import XCTest
@testable import RatKing

final class MessageFoldTests: XCTestCase {
    private var seed: UInt64 = 2026_10_11
    private func next(_ bound: Int) -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int((seed >> 33) % UInt64(max(1, bound))) }
    private func words(_ count: Int) -> String {
        let letters = Array("abcdéfgh")
        return (0..<count).map { _ in String(repeating: letters[next(letters.count)], count: 1 + (next(10) == 0 ? next(70) : next(9))) }.joined(separator: " ")
    }
    private func message() -> String {
        (0..<next(9)).map { _ in next(5) == 0 ? "" : words(1 + next(40)) }.joined(separator: next(2) == 0 ? "\n" : "\r\n\t")
    }

    // Fit check at phone column widths: never more than four lines, markers always on
    // line one, and `+N` exactly when text is hidden, N counting every line not fully shown.
    func testCollapsedCardFitsFourLinesWithMarkersAndHiddenCount() {
        let pool = ["↩", "12:04 PM", "DELIVERED", "CC"]
        for width in [40, 60, 80, 120] {
            for _ in 0..<500 {
                let sender = words(1 + next(6)), markers = pool.filter { _ in next(2) == 0 }
                let body = message(), summary: String? = next(3) == 0 ? nil : next(6) == 0 ? body : words(next(60))
                let fold = MessageFold(sender: sender, markers: markers, summary: summary, body: body, width: width)
                let lines = [fold.heading] + fold.lines
                XCTAssertLessThanOrEqual(lines.count, 4, "width \(width)")
                XCTAssertTrue(fold.heading.hasSuffix(markers.map { " · " + $0 }.joined()))
                for line in lines { XCTAssertLessThanOrEqual(line.count, width, "width \(width): \(line)") }

                let used = summary.map(MessageText.oneLine).flatMap { $0.isEmpty ? nil : $0 }
                let content = MessageFold.wrap(used ?? body, width: width)
                let behind = used == nil || MessageText.oneLine(body) == used ? 0 : MessageFold.wrap(body, width: width).count
                let suffix = MessageFold.more(fold.hidden)
                let full = fold.lines.enumerated().filter { index, line in
                    index < content.count && (line == content[index] || line == content[index] + suffix)
                }.count
                XCTAssertEqual(fold.hidden, content.count + behind - full, "width \(width)")
                XCTAssertEqual(fold.lines.last?.hasSuffix(suffix.trimmingCharacters(in: .whitespaces)) == true, fold.hidden > 0, "width \(width)")
            }
        }
    }

    // Phone sends are pi-ratking payloads: body intact, and a one-line summary of at most
    // 280 UTF-16 units, typed or the first sentence.
    func testOutgoingPayloadCarriesBodyAndOneLineSummary() {
        let phone = "did:web:sample-phone.ratking-fleet.invalid"
        for _ in 0..<500 {
            let body = message() + "x", typed = next(2) == 0 ? "" : message()
            let parsed = MessageText(MessageText.outgoing(body: body, summary: typed, senderDid: phone))
            XCTAssertEqual(parsed.text, body); XCTAssertEqual(parsed.from, "sample-phone")
            let summary = parsed.summary ?? ""
            XCTAssertLessThanOrEqual(summary.utf16.count, MessageText.summaryLimit)
            XCTAssertFalse(summary.contains(where: \.isNewline))
            let source = MessageText.oneLine(typed).isEmpty ? MessageText.oneLine(String(body.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? "")) : MessageText.oneLine(typed)
            XCTAssertTrue(source.hasPrefix(summary.hasSuffix("…") ? String(summary.dropLast()) : summary))
        }
        XCTAssertEqual(MessageText.outgoing(body: "Plain", summary: "", senderDid: "did:web:Not A Name.example.invalid"), "Plain")
    }
}
