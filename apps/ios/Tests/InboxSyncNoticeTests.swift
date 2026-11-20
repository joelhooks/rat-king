import XCTest
@testable import RatKing

final class InboxSyncNoticeTests: XCTestCase {
    func testProgressOnlyDescribesAnActiveConnection() {
        for count in 0..<64 {
            for savedCount in [0, 1, 3] {
                let saved = Array(0..<savedCount)
                var presentation = InboxPresentation<Int>()
                presentation.resume(saved)
                presentation.loaded(count)

                let suffix = saved.isEmpty ? "" : " · showing saved mail"
                XCTAssertEqual(presentation.syncNotice(state: .stopped, hasError: true), "Mail sync stopped" + suffix)
                XCTAssertEqual(presentation.syncNotice(state: .retrying, hasError: true), "Trying to reconnect" + suffix)
                XCTAssertEqual(presentation.syncNotice(state: .waiting, hasError: false), saved.isEmpty ? nil : "Showing saved mail")

                let activeNotice = saved.isEmpty
                    ? (count == 0 ? "Connecting to mail…" : "Loading mail (\(count))…")
                    : "Syncing saved mail (\(count))…"
                for state in [ConnectionState.acquiring, .authenticating, .catchingUp] {
                    XCTAssertEqual(presentation.syncNotice(state: state, hasError: false), activeNotice)
                }
                presentation.settle(saved)
                XCTAssertNil(presentation.syncNotice(state: .live, hasError: false))
                XCTAssertEqual(presentation.visible, saved)
            }
        }
    }
}
