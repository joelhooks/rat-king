import XCTest

final class TimelineTests: XCTestCase {
    @MainActor func testTimelineAskOpensSealedChoicesWithoutAChatHop() {
        let app = XCUIApplication()
        app.launchArguments = ["--timeline-test"]
        app.launch()
        let ask = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Review synthetic release")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        ask.tap()
        let seal = app.buttons["[SEAL + SEND ANSWER]"]
        XCTAssertTrue(seal.waitForExistence(timeout: 5))
        XCTAssertFalse(seal.isEnabled)
        XCTAssertFalse(app.buttons["[SIGN + SEND REPLY]"].exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "timeline-open-desk-ask"
        shot.lifetime = .keepAlways
        add(shot)
    }

    @MainActor func testTimelineOpensThreadAndRetainsDraftAcrossWidths() {
        let app = XCUIApplication()
        app.launchArguments = ["--timeline-test"]
        app.launch()
        let post = app.buttons.containing(.staticText, identifier: "Read https://example.invalid/chat").firstMatch
        XCTAssertTrue(post.waitForExistence(timeout: 5))
        post.tap()
        let composer = app.descendants(matching: .any)["conversation-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("invented draft")
        let resize = app.buttons["timeline-test-width"]
        let isWide = post.exists
        if isWide {
            resize.tap()
            XCTAssertTrue(app.buttons["‹ Timeline"].waitForExistence(timeout: 5))
            XCTAssertFalse(post.exists)
            XCTAssertEqual(composer.value as? String, "invented draft")
            resize.tap()
            XCTAssertTrue(post.waitForExistence(timeout: 5))
        } else {
            let back = app.buttons["‹ Timeline"]
            XCTAssertTrue(back.exists)
            back.tap()
            XCTAssertTrue(post.waitForExistence(timeout: 5))
            post.tap()
        }
        XCTAssertEqual(composer.value as? String, "invented draft")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = isWide ? "timeline-split" : "timeline-compact"
        shot.lifetime = .keepAlways
        add(shot)
        app.buttons["timeline-compose"].tap()
        XCTAssertTrue(app.staticTexts["Sample Alpha"].waitForExistence(timeout: 5))
    }
}
