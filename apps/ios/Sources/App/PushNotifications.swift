import CoreFoundation
import Observation
import UIKit
import UserNotifications

struct PushDevice: Equatable {
    let token: String
    let environment: String

    init(data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        environment = "sandbox"
        #else
        environment = "production"
        #endif
    }
}

struct PushTap: Equatable {
    let messageId: String
    let seq: Int64?

    init?(_ payload: [AnyHashable: Any]) {
        guard let id = payload["messageId"] as? String, id.utf8.count == 13,
              id.utf8.allSatisfy({ (50...55).contains($0) || (97...122).contains($0) }) else { return nil }
        messageId = id
        if let number = payload["admissionSeq"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let n = number.doubleValue
            seq = n > 0 && n < 9_007_199_254_740_991 && n.rounded() == n ? number.int64Value : nil
        } else {
            seq = nil
        }
    }
}

@MainActor @Observable
final class PushNotifications: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private(set) var device: PushDevice?
    private(set) var status: String?
    var pendingTap: PushTap?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func enable() async {
        #if !targetEnvironment(simulator)
        let center = UNUserNotificationCenter.current()
        do {
            guard try await center.requestAuthorization(options: [.alert, .sound]) else {
                status = "Notifications off. Allow Rat King notifications in Settings."
                return
            }
            UIApplication.shared.registerForRemoteNotifications()
        } catch { status = "Could not request notification permission." }
        #endif
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard !deviceToken.isEmpty else { return }
        status = nil
        device = PushDevice(data: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        status = "Could not register with Apple Push Notifications."
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let tap = PushTap(response.notification.request.content.userInfo) else { return }
        await MainActor.run { pendingTap = tap }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
