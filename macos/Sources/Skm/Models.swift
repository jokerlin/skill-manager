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

struct EffectiveEntry: Codable, Hashable, Identifiable {
    var id: String { path }
    let name: String
    let source: String        // user | legacy | builtin | plugin
    let sourceText: String
    let storage: String
    let owner: String
    let path: String
    let version: String?
    let enabled: String       // on
    let listingChars: Int
    let bodyTokens: Int
    let hash: String
    // v2.1 (optional so older CLIs still decode)
    let listing: String?
    let promptVisible: Bool?  // false = Codex loads it but hides it from the model-visible catalog
    let plugin: String?
    let marketplace: String?
    let dir: String?

    var sourceLabel: String {
        switch source {
        case "plugin": return "\(plugin ?? "?")@\(marketplace ?? "?")"
        case "legacy": return "legacy \(dir ?? "")"
        default: return source
        }
    }
}

struct SourceCounts: Codable, Hashable {
    let user: Int
    let legacy: Int
    let builtin: Int
    let plugin: Int
    var total: Int { user + legacy + builtin + plugin }
}

struct PluginStatus: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let marketplace: String
    let enabled: String       // on | off
    let version: String?
    let dir: String?
    let skills: [String]
    let cachedVersions: [String]
}

/// "c" for char budgets (Claude), "t" for token budgets (Codex); older JSON without `unit` is chars.
func budgetUnit(_ unit: String?) -> String { unit == "tokens" ? "t" : "c" }
/// What the simulation predicts happens to the overflow, matching skm's `trimText`.
func budgetTrimText(_ trim: String?, _ count: Int) -> String {
    switch trim {
    case "shortened": return "\(count) descriptions shortened"
    case "omitted": return "\(count) skills omitted entirely"
    default: return "~\(count) descriptions dropped"
    }
}

struct AgentBudget: Codable, Hashable {
    let usedChars: Int
    let budgetChars: Int?
    let droppedCount: Int
    let overBy: Int
    let note: String
    let unit: String?
    let trim: String?
    var u: String { budgetUnit(unit) }
    var trimText: String { budgetTrimText(trim, droppedCount) }
}

struct AgentStatus: Codable, Hashable {
    let dir: String
    let exists: Bool
    let consumed: [ConsumedEntry]
    let desired: [String]
    let alsoReads: [String: [String]]
    // v2 (optional so older CLIs still decode)
    let effective: [EffectiveEntry]?
    let counts: SourceCounts?
    let plugins: [PluginStatus]?
    let budget: AgentBudget?
}

struct HostFinding: Codable, Hashable, Identifiable {
    var id: String { "\(kind)/\(text.hashValue)" }
    let kind: String
    let text: String
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
    let tools: [String: String]?
    let findings: [HostFinding]?
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
    let tokens: Int?
    let budgetChars: Int?
    let droppedCount: Int
    let overBy: Int
    let unit: String?
    let trim: String?
    var u: String { budgetUnit(unit) }
    var trimText: String { budgetTrimText(trim, droppedCount) }
}

struct Insight: Codable, Identifiable, Hashable {
    var id: String { "\(kind)/\(skill)/\(detail.hashValue)" }
    let skill: String
    let kind: String
    let detail: String
    let related: [String]
}

struct DoctorFinding: Codable, Hashable, Identifiable {
    var id: String { "\(kind)/\(text.hashValue)" }
    let kind: String
    let text: String
    let host: String?
    let agent: String?
}

struct DoctorReport: Codable {
    let store: String
    let skillCount: Int
    let contextTokens: Int
    let budget: [BudgetRow]
    let insights: [Insight]
    let findings: [DoctorFinding]?
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

/// Ops that change a host: file ops plus the v2 plugin / owner-CLI commands. Everything else is a report.
let mutationOps: Set<String> = ["mkdir", "rsync-skill", "link", "unlink", "marketplace-add", "plugin-install", "plugin-enable", "plugin-disable", "owned-ensure"]

/// One row of the skills catalog: the union of the hub store and everything any agent on any host actually loads.
struct CatalogItem: Identifiable, Hashable {
    enum Group: Hashable {
        case store
        case plugin(String)   // "name@marketplace"
        case builtin
        case other(String)    // owner of an unmanaged real dir / foreign link
        var order: Int { switch self { case .store: return 0; case .other: return 1; case .builtin: return 2; case .plugin: return 3 } }
        var text: String { switch self { case .store: return "store"; case let .plugin(p): return p; case .builtin: return "codex builtin"; case let .other(o): return "unmanaged (\(o))" } }
    }
    let id: String
    let name: String
    let group: Group
    let description: String
    let listingChars: Int
    let bodyTokens: Int
    let versions: [String]
    /// host → agent → the entry that agent loads
    let loads: [String: [String: EffectiveEntry]]
    let store: SkillRow?

    var cells: Int { loads.values.reduce(0) { $0 + $1.count } }
    var loadsText: String {
        loads.isEmpty ? "not loaded anywhere" : loads.keys.sorted().map { "\($0) ×\(loads[$0]!.count)" }.joined(separator: " · ")
    }
}

enum Catalog {
    static func key(_ e: EffectiveEntry, storeNames: Set<String>) -> (String, CatalogItem.Group) {
        switch e.source {
        case "plugin":
            let pid = "\(e.plugin ?? "?")@\(e.marketplace ?? "?")"
            return ("plugin:\(pid):\(e.name)", .plugin(pid))
        case "builtin":
            return ("builtin:\(e.name)", .builtin)
        default:
            return storeNames.contains(e.name) ? ("store:\(e.name)", .store) : ("other:\(e.owner):\(e.name)", .other(e.owner))
        }
    }

    /// Store rows first (with their live loads), then everything else agents load, grouped by plugin / builtin / owner.
    static func build(skills: [SkillRow], hosts: [HostStatus]) -> [CatalogItem] {
        let storeNames = Set(skills.map(\.name))
        var loads: [String: [String: [String: EffectiveEntry]]] = [:]
        var groups: [String: (name: String, group: CatalogItem.Group)] = [:]
        for h in hosts {
            for (agent, st) in h.agents ?? [:] {
                for e in st.effective ?? [] {
                    let (k, g) = key(e, storeNames: storeNames)
                    loads[k, default: [:]][h.host, default: [:]][agent] = e
                    groups[k] = (e.name, g)
                }
            }
        }
        let storeItems = skills.map { s in
            CatalogItem(id: "store:\(s.name)", name: s.name, group: .store, description: s.description, listingChars: s.descChars, bodyTokens: s.bodyTokens, versions: [], loads: loads["store:\(s.name)"] ?? [:], store: s)
        }
        let rest = groups.filter { !$0.key.hasPrefix("store:") }.map { k, g -> CatalogItem in
            let entries = (loads[k] ?? [:]).values.flatMap { $0.values }
            let sample = entries.max { ($0.listing ?? "").count < ($1.listing ?? "").count }
            return CatalogItem(id: k, name: g.name, group: g.group, description: sample?.listing ?? "", listingChars: sample?.listingChars ?? 0, bodyTokens: sample?.bodyTokens ?? 0, versions: Array(Set(entries.compactMap(\.version))).sorted(), loads: loads[k] ?? [:], store: nil)
        }
        return storeItems + rest.sorted { $0.id < $1.id }
    }
}
