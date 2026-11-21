import SwiftUI

extension View {
    func readingColumn() -> some View {
        frame(maxWidth: 600, alignment: .leading).frame(maxWidth: .infinity)
    }
}

struct ReadingBody: View {
    let text: String

    var body: some View {
        Text(text).font(.body).lineSpacing(4).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct PeerHeading: View {
    let agent: AgentIdentity

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(agent.headline).font(.headline).foregroundStyle(TUITheme.accent)
                .fixedSize(horizontal: false, vertical: true)
            if let project = agent.project {
                Text("PROJECT " + project).font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
            }
            DisclosureGroup("Peer details") {
                if agent.name != agent.headline, agent.name != agent.did {
                    Text(agent.name).foregroundStyle(TUITheme.teal)
                }
                Text(agent.did).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }.font(TUITheme.microFont).foregroundStyle(TUITheme.dim).accessibilityIdentifier("peer-details")
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension AgentIdentity {
    var headline: String {
        if let callsign, !callsign.isEmpty, !callsign.contains(did) { return callsign }
        if name == did || name.isEmpty { return "Unknown agent" }
        return name
    }
}
