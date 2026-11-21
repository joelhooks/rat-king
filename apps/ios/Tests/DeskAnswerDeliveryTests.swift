import XCTest
@testable import RatKing

final class DeskAnswerDeliveryTests: XCTestCase {
    func testSavedAndAdmittedAnswersNeverClaimDeliveryBeforeAReceipt() throws {
        let receipts: [(String, DeskAnswerDelivery)] = [
            ("accepted", .admitted), ("queued", .queued), ("delivered", .delivered),
            ("acked", .acknowledged), ("expired", .expired), ("rejected", .rejected), ("failed", .rejected)
        ]
        let legacy = try ThreadPreferences(.map(["state": .string("open"), "archived": .bool(false)]))
        XCTAssertNil(legacy.answerReceipt)
        for pending in [false, true] {
            for failed in [false, true] {
                let local = DeskAnswerDelivery.project(pending: pending, failed: failed, preferences: legacy)
                XCTAssertEqual(local, pending ? .pending : failed ? .failed : nil)
                for (receipt, expected) in receipts {
                    var saved = legacy
                    saved.answerReceipt = receipt
                    let restored = try ThreadPreferences(Value.json(saved.wire.jsonData()))
                    XCTAssertEqual(DeskAnswerDelivery.project(pending: pending, failed: failed, preferences: restored), expected)
                }
            }
        }
    }
}
