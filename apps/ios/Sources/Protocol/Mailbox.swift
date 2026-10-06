import Foundation

struct ClientConfiguration: Sendable {
    let endpoint: URL
    let audience: String
    let did: String
    static func load() throws -> Self {
        func setting(_ key: String) throws -> String {
            guard let s = Bundle.main.object(forInfoDictionaryKey: key) as? String, !s.isEmpty, !s.contains("$("), !s.contains("example.invalid") else { throw ProtocolError.invalid("Configure \(key) in Local.xcconfig before joining") }; return s
        }
        let text = try setting("RKMailboxURL")
        guard let url = URL(string: text), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw ProtocolError.invalid("Mailbox requires a credential-free HTTPS URL") }
        return try Self(endpoint: url, audience: setting("RKMailboxAudience"), did: setting("RKPhoneDID"))
    }
}
struct XRPCError: Error, LocalizedError {
    let code: String
    let status: Int
    var errorDescription: String? { "\(code) (HTTP \(status))" }
}
struct Lease: Sendable {
    let value: Value
    let id: String
    let generation: Int64
    let expiresAt: Date
    init(_ v: Value, did: String) throws {
        guard try v.required("did").text == did else { throw ProtocolError.invalid("Lease DID mismatch") }
        id = try v.required("leaseId").text
        generation = try v.required("generation").number
        let expiryText = try v.required("expiresAt").text
        guard generation > 0, let expiry = ISO8601DateFormatter().date(from: expiryText) ?? ISO8601DateFormatter.fractional.date(from: expiryText) else { throw ProtocolError.invalid("Invalid lease") }
        expiresAt = expiry; value = v
    }
    var fence: [String: Value] { ["leaseId": .string(id), "generation": .int(generation)] }
}
extension ISO8601DateFormatter {
    static var fractional: ISO8601DateFormatter { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }
}

// Provider adapter. Protocol values stay independent of URLSession and phone UI.
struct Mailbox: Sendable {
    let configuration: ClientConfiguration
    let identity: PhoneIdentity
    let session: URLSession
    static let namespace = "sh.mschf.ratking."
    init(configuration: ClientConfiguration, identity: PhoneIdentity) {
        self.configuration = configuration; self.identity = identity
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 20; c.timeoutIntervalForResource = 30
        // Never forward a bearer token through a redirect to another host.
        session = URLSession(configuration: c, delegate: NoRedirect(), delegateQueue: nil)
    }
    func url(_ method: String, params: [String: String] = [:], websocket: Bool = false) throws -> URL {
        var c = URLComponents(url: configuration.endpoint.appendingPathComponent("xrpc/" + Self.namespace + method), resolvingAgainstBaseURL: false)
        if websocket { c?.scheme = "wss" }
        if !params.isEmpty { c?.queryItems = params.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = c?.url else { throw ProtocolError.invalid("Invalid mailbox URL") }; return url
    }
    func call(_ method: String, params: [String: String] = [:], body: Value? = nil) async throws -> Value {
        var request = URLRequest(url: try url(method, params: params))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("Bearer " + (try identity.token(audience: configuration.audience, method: Self.namespace + method)), forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try body.jsonData(); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (bytes, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, bytes.count <= 2_000_000 else { throw ProtocolError.invalid("Invalid mailbox response") }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? Value.json(bytes)
            throw XRPCError(code: (try? error?.required("error").text) ?? "MailboxRequestFailed", status: http.statusCode)
        }
        return try Value.json(bytes)
    }
    func acquire() async throws -> Lease {
        let request: Value = .map(["did": .string(identity.did), "harness": .map(["$type": .string(Self.namespace + "runtime.lease#other"), "kind": .string("ios")]), "expiresAt": .string(ISO8601DateFormatter.fractional.string(from: Date().addingTimeInterval(300)))])
        return try await Lease(call("runtime.acquireLease", body: request).required("lease"), did: identity.did)
    }
    func renew(_ lease: Lease) async throws -> Lease {
        var fields = lease.fence; fields["did"] = .string(identity.did)
        fields["expiresAt"] = .string(ISO8601DateFormatter.fractional.string(from: Date().addingTimeInterval(300)))
        return try await Lease(call("runtime.renewLease", body: .map(fields)).required("lease"), did: identity.did)
    }
    func socket(_ lease: Lease) throws -> URLSessionWebSocketTask {
        session.webSocketTask(with: try url("mailbox.subscribe", params: ["recipientDid": identity.did, "leaseId": lease.id, "generation": String(lease.generation)], websocket: true))
    }
    func authenticate(_ socket: URLSessionWebSocketTask) async throws {
        let auth: Value = .map(["$type": .string(Self.namespace + "mailbox.subscribe#auth"), "token": .string(try identity.token(audience: configuration.audience, method: Self.namespace + "mailbox.subscribe"))])
        try await socket.send(.string(String(decoding: auth.jsonData(), as: UTF8.self)))
    }
    func notice(_ socket: URLSessionWebSocketTask) async throws -> Int64 {
        let frame = try await socket.receive()
        let bytes: Data
        switch frame { case let .data(d): bytes = d; case let .string(s): bytes = Data(s.utf8); @unknown default: throw ProtocolError.invalid("Unknown socket frame") }
        guard bytes.count <= 4096 else { throw ProtocolError.invalid("Socket frame too large") }
        let value = try Value.json(bytes)
        guard value["$type"] == .string(Self.namespace + "mailbox.subscribe#notice") else { throw ProtocolError.invalid("Unexpected socket notice") }
        return try value.required("seq").number
    }
    func transition(_ method: String, message: Value, lease: Lease) async throws -> Value {
        var fields = lease.fence; fields["recipientDid"] = .string(identity.did); fields["message"] = message
        return try await call("mailbox." + method, body: .map(fields)).required("receipt")
    }
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
