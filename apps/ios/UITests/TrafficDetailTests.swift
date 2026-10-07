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
            XCTAssertTrue(app.staticTexts["Traffic contains metadata, not message text."].waitForExistence(timeout: 5))
            capture(app, "\(theme)-traffic-content-slot")
            app.swipeDown(); app.buttons["[← back]"].tap()
            XCTAssertTrue(row.waitForExistence(timeout: 5)); app.terminate()
        }
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name
        attachment.lifetime = .keepAlways; add(attachment)
    }
}
