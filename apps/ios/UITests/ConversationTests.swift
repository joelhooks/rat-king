import XCTest

final class ConversationTests: XCTestCase {
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
