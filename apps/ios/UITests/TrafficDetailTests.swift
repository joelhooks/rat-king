import XCTest

final class TrafficDetailTests: XCTestCase {
    @MainActor func testTrafficTapShowsFullMetadataTimelineAndContentSlotThenReturns() {
        for theme in ["Light", "Dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["--traffic-preview-test", "-AppleInterfaceStyle", theme]; app.launch()
            let row = app.buttons["traffic-row-4"]
            XCTAssertTrue(row.waitForExistence(timeout: 5)); capture(app, "\(theme)-traffic-list"); row.tap()
            for value in ["did:web:sample-sender.example.invalid", "did:web:sample-recipient.example.invalid", "3m5abcde23456", "1024 bytes"] {
                XCTAssertTrue(app.staticTexts[value].waitForExistence(timeout: 5))
            }
            for seq in 1...4 { XCTAssertTrue(app.staticTexts["2026-01-01T12:00:0\(seq).000Z"].exists) }
            capture(app, "\(theme)-traffic-detail")
            app.swipeUp()
            XCTAssertTrue(app.staticTexts["content not copied to this phone"].waitForExistence(timeout: 5))
            capture(app, "\(theme)-traffic-content-slot")
            app.swipeDown(); app.buttons["[← back]"].tap()
            XCTAssertTrue(row.waitForExistence(timeout: 5)); app.terminate()
        }
    }
    @MainActor func testTrafficDetailLabelsSealedCopyAndKeepsPrimaryTimeline() {
        let app = XCUIApplication()
        app.launchArguments = ["--traffic-preview-test", "--traffic-copy-test"]; app.launch()
        let row = app.buttons["traffic-row-4"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        for seq in 1...4 { XCTAssertTrue(app.staticTexts["2026-01-01T12:00:0\(seq).000Z"].exists) }
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["CC COPY / VERIFIED SENDER"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Synthetic copied content"].exists)
        XCTAssertTrue(app.staticTexts["COPY RECEIVED 2026-01-01T12:00:05.000Z"].exists)
        XCTAssertFalse(app.staticTexts["content not copied to this phone"].exists)
        capture(app, "traffic-sealed-copy"); app.terminate()
    }
    @MainActor func testSystemEdgeSwipeReturnsFromTrafficDetail() {
        let app = XCUIApplication(); app.launchArguments = ["--traffic-preview-test"]; app.launch()
        let row = app.buttons["traffic-row-4"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.staticTexts["MESSAGE ID"].waitForExistence(timeout: 5))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.45)))
        let returned = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: row)
        XCTAssertEqual(XCTWaiter.wait(for: [returned], timeout: 5), .completed)
        capture(app, "traffic-edge-swipe-back"); app.terminate()
    }
    @MainActor func testArchiveAndNextStaysInDetailThenReturnsAtEnd() {
        let app = XCUIApplication(); app.launchArguments = ["--traffic-preview-test", "--traffic-next-test"]; app.launch()
        let newest = app.buttons["traffic-row-5"]
        XCTAssertTrue(newest.waitForExistence(timeout: 5)); newest.tap()
        XCTAssertTrue(app.staticTexts["3m5abcde23457"].waitForExistence(timeout: 5))
        app.buttons["archive-next"].tap()
        XCTAssertTrue(app.staticTexts["3m5abcde23456"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["archive-next"].isHittable)
        capture(app, "traffic-archive-next")
        app.buttons["archive-next"].tap()
        XCTAssertTrue(app.buttons["[restore archived traffic]"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["traffic-row-4"].exists); XCTAssertFalse(newest.exists)
        app.terminate()
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name
        attachment.lifetime = .keepAlways; add(attachment)
    }
}
