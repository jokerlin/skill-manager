import Foundation

// Codable mirrors of the CLI's --json output. The CLI is the engine; this app only renders.

struct SkillRow: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String
    let descChars: Int
    let descTokens: Int
    let bodyTokens: Int
    let bodyLines: Int
    let files: Int
    let bytes: Int
    let violations: [String]
    let hash: String
    /// host → agent → wanted (from config rules)
    let targets: [String: [String: Bool]]
    let insights: [String]
}

struct ConsumedEntry: Codable, Hashable {
    let name: String
    let kind: String   // managed | dir | foreign-link | broken-link
    let target: String?
}

struct AgentStatus: Codable, Hashable {
    let dir: String
    let exists: Bool
    let consumed: [ConsumedEntry]
    let desired: [String]
    let alsoReads: [String: [String]]
}

struct HostStatus: Codable, Identifiable, Hashable {
    var id: String { host }
    let host: String
    let reachable: Bool
    let error: String?
    let home: String?
    let store: [String]?
    let remoteOnly: [String]?
    let agents: [String: AgentStatus]?
    let drift: [String]?
}

struct HostPlan: Codable, Identifiable, Hashable {
    var id: String { host }
    let host: String
    let reachable: Bool
    let error: String?
    let ops: [PlanOp]
}

struct PlanOp: Codable, Hashable {
    let op: String
    let text: String
}

struct BudgetRow: Codable, Identifiable, Hashable {
    var id: String { "\(host)/\(agent)" }
    let host: String
    let agent: String
    let skills: Int
    let usedChars: Int
    let tokens: Int
    let budgetChars: Int?
    let droppedCount: Int
    let overBy: Int
}

struct Insight: Codable, Identifiable, Hashable {
    var id: String { "\(kind)/\(skill)/\(detail.hashValue)" }
    let skill: String
    let kind: String
    let detail: String
    let related: [String]
}

struct DoctorReport: Codable {
    let store: String
    let skillCount: Int
    let contextTokens: Int
    let budget: [BudgetRow]
    let insights: [Insight]
}

struct EvalItem: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let usefulness: Int
    let description_quality: Int
    let overlaps: [String]
    let verdict: String
    let trim_suggestion: String
    let reason: String
    let evaluatedAt: String?
}

struct ConfigSummary: Codable {
    let hosts: [String]
    let agents: [String]
    let store: String
}
