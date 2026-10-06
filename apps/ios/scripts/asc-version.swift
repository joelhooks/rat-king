import CryptoKit
import Foundation

// Upload-time provider adapter. This key is the leased ASC credential, never a
// phone identity key. Output contains app/build versions only, never the JWT.
func b64(_ d: Data) -> String { d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
func fail(_ message: String) throws -> Never { throw NSError(domain: "ASCPreflight", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func json(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
func version(_ text: String) throws -> [Int] {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)
    guard (1...3).contains(parts.count), parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }), let major = Int(parts[0]) else { try fail("Malformed ASC version") }
    let rest = try parts.dropFirst().map { part -> Int in guard let n = Int(part) else { try fail("Malformed ASC version") }; return n }
    return [major] + rest + Array(repeating: 0, count: 3-parts.count)
}
final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
let args = CommandLine.arguments
if args.count != 6 { try fail("Expected key path, key ID, issuer, bundle ID and proposed version") }
let key = try P256.Signing.PrivateKey(pemRepresentation: String(contentsOfFile: args[1], encoding: .utf8))
let now = Int(Date().timeIntervalSince1970)
let header = try b64(json(["alg": "ES256", "kid": args[2], "typ": "JWT"]))
let payload = try b64(json(["iss": args[3], "iat": now, "exp": now+900, "aud": "appstoreconnect-v1"]))
let signing = header + "." + payload
let token = try signing + "." + b64(key.signature(for: Data(signing.utf8)).rawRepresentation)
let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = 30
let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
func get(_ url: URL) async throws -> [String: Any] {
    guard url.scheme == "https", url.host == "api.appstoreconnect.apple.com", url.user == nil, url.password == nil else { try fail("Refusing credential forwarding") }
    var request = URLRequest(url: url); request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count < 10_000_000 else { try fail("ASC read failed; refusing upload") }
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("Malformed ASC response") }; return value
}
var appURL = URLComponents(string: "https://api.appstoreconnect.apple.com/v1/apps")!
appURL.queryItems = [URLQueryItem(name: "filter[bundleId]", value: args[4]), URLQueryItem(name: "limit", value: "2")]
let apps = try await get(appURL.url!)
guard let data = apps["data"] as? [[String: Any]], data.count == 1, let app = data.first?["id"] as? String else { try fail("Expected one existing ASC app; never creating it") }
var buildsURL = URLComponents(string: "https://api.appstoreconnect.apple.com/v1/builds")!
buildsURL.queryItems = [URLQueryItem(name: "filter[app]", value: app), URLQueryItem(name: "sort", value: "-uploadedDate"), URLQueryItem(name: "limit", value: "200"), URLQueryItem(name: "include", value: "preReleaseVersion")]
var next: URL? = buildsURL.url
var highest = [0, 0, 0], latestVersion = "none", latestBuild = "none", maxBuild: UInt64 = 0
var pages = 0
while let url = next {
    pages += 1; guard pages <= 100 else { try fail("ASC history pagination limit; refusing incomplete preflight") }
    let page = try await get(url)
    guard let builds = page["data"] as? [[String: Any]] else { try fail("Malformed build history") }
    let included = page["included"] as? [[String: Any]] ?? []
    for build in builds {
        guard let attributes = build["attributes"] as? [String: Any], let number = attributes["version"] as? String,
              let relations = build["relationships"] as? [String: Any], let release = relations["preReleaseVersion"] as? [String: Any],
              let releaseData = release["data"] as? [String: Any], let id = releaseData["id"] as? String,
              let record = included.first(where: { $0["id"] as? String == id }), let releaseAttributes = record["attributes"] as? [String: Any],
              let text = releaseAttributes["version"] as? String else { try fail("Missing build version relationship") }
        let parsed = try version(text)
        if highest.lexicographicallyPrecedes(parsed) { highest = parsed }
        if latestBuild == "none" { latestBuild = number; latestVersion = text }
        guard let numeric = UInt64(number) else { try fail("Non-integer existing build number; operator decision required") }; maxBuild = max(maxBuild, numeric)
    }
    if let links = page["links"] as? [String: Any], let text = links["next"] as? String {
        guard let url = URL(string: text) else { try fail("Malformed pagination link") }; next = url
    } else { next = nil }
}
let proposed = try version(args[5])
let chosen = highest.lexicographicallyPrecedes(proposed) ? args[5] : "\(highest[0]).\(highest[1]+1).0"
let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyyMMddHHmm"
let buildNumber = formatter.string(from: Date())
guard let numeric = UInt64(buildNumber), numeric > maxBuild else { try fail("UTC timestamp is not above existing builds; operator decision required") }
let output: [String: Any] = ["marketingVersion": chosen, "buildNumber": buildNumber, "latestVersion": latestVersion, "latestBuild": latestBuild, "maxExistingBuild": String(maxBuild)]
print(String(decoding: try json(output), as: UTF8.self))
