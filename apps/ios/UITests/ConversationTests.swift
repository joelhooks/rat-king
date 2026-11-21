import XCTest

final class ConversationTests: XCTestCase {
    @MainActor func testNeedsAnswerFilterAndDeskChoice() {
        let app = XCUIApplication(); app.launchArguments = ["--conversation-test"]; app.launch()
        let filter = app.buttons["needs answer"]
        let ask = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Review synthetic release")).firstMatch
        let chat = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Sample Alpha")).firstMatch
        XCTAssertTrue(filter.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(filter.frame.height, 44)
        XCTAssertTrue(ask.exists); XCTAssertTrue(chat.exists)
        XCTAssertTrue(ask.label.contains("NEEDS ANSWER"))
        attach(app, "chats-before-filter")
        filter.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(ask.exists); XCTAssertFalse(chat.exists)
        attach(app, "needs-answer-filtered")
        ask.tap()
        XCTAssertFalse(app.buttons["[open desk item]"].exists)
        let accept = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Accept candidate")).firstMatch
        XCTAssertTrue(accept.waitForExistence(timeout: 5)); accept.tap()
        XCTAssertTrue(accept.label.contains("[x]"))
        XCTAssertFalse(app.buttons["[SEAL + SEND ANSWER]"].isEnabled)
        XCTAssertFalse(app.buttons["[SIGN + SEND REPLY]"].exists)
        attach(app, "desk-choice-selected")
        app.terminate()
    }

    @MainActor func testHTTPSLinkInLongDeskMessageOpensOnlyOnTap() {
        let app = XCUIApplication(); app.launchArguments = ["--conversation-test"]; app.launch()
        let ask = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Review synthetic release")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5)); ask.tap()
        let open = app.buttons["[open desk item]"]
        XCTAssertTrue(open.waitForExistence(timeout: 5)); open.tap()
        let expand = app.buttons["[+ full message]"]
        let destination = "https://example.invalid/review"
        let link = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Open " + destination)).firstMatch
        let opened = app.staticTexts["opened-message-link"]
        XCTAssertTrue(expand.waitForExistence(timeout: 5)); XCTAssertFalse(link.exists)
        expand.tap()
        XCTAssertTrue(link.waitForExistence(timeout: 5)); XCTAssertFalse(opened.exists)
        attach(app, "desk-message-https-link")
        link.tap()
        XCTAssertTrue(opened.waitForExistence(timeout: 5)); XCTAssertEqual(opened.label, destination)
        app.terminate()
    }

    @MainActor func testHTTPSLinkInShortChatIsAvailableWithoutUnfolding() {
        let app = XCUIApplication(); app.launchArguments = ["--conversation-test"]; app.launch()
        let chat = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Sample Alpha")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 5)); chat.tap()
        let destination = "https://example.invalid/chat"
        let link = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Open " + destination)).firstMatch
        let opened = app.staticTexts["opened-message-link"]
        XCTAssertTrue(link.waitForExistence(timeout: 5)); XCTAssertFalse(opened.exists)
        link.tap()
        XCTAssertTrue(opened.waitForExistence(timeout: 5)); XCTAssertEqual(opened.label, destination)
        XCTAssertTrue(link.exists)
        app.terminate()
    }

    @MainActor private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    @MainActor func testNewMessagePicksAgentAndOpensConversationWithComposerFocused() {
        let app = XCUIApplication(); app.launchArguments = ["--conversation-test"]; app.launch()
        let new = app.buttons["new-message"]
        XCTAssertTrue(new.waitForExistence(timeout: 5)); new.tap()
        let agent = app.buttons.matching(identifier: "agent-other-project/gamma").firstMatch
        XCTAssertTrue(agent.waitForExistence(timeout: 5)); agent.tap()
        XCTAssertTrue(app.staticTexts["did:web:other-project.gamma.pi.ratking-fleet.invalid"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "conversation-composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        let focused = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasKeyboardFocus == true"), object: composer)
        XCTAssertEqual(XCTWaiter.wait(for: [focused], timeout: 5), .completed)
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = "conversation-composer-focused"
        attachment.lifetime = .keepAlways; add(attachment)
        app.terminate()
    }
}
