import SwiftUI

// MARK: - Skills

struct SkillsView: View {
    @EnvironmentObject var model: AppModel
    @State private var selected: String?
    @State private var filter = ""
    /// Click a column header to sort by it, click again to flip; default is source group then name.
    @State private var sortOrder = [KeyPathComparator(\CatalogItem.sourceKey)]
    @State private var scope: Scope = .all

    enum Scope: String, CaseIterable, Identifiable {
        case all = "All", store = "Store", plugins = "Plugins", builtin = "Builtin", other = "Unmanaged"
        var id: String { rawValue }
        func matches(_ g: CatalogItem.Group) -> Bool {
            switch (self, g) {
            case (.all, _), (.store, .store), (.plugins, .plugin), (.builtin, .builtin), (.other, .other): return true
            default: return false
            }
        }
    }

    private var catalog: [CatalogItem] { Catalog.build(skills: model.skills, hosts: model.hosts) }
    private func count(_ s: Scope) -> Int { catalog.filter { s.matches($0.group) }.count }
    private var visible: [CatalogItem] {
        let q = filter.lowercased()
        let scoped = catalog.filter { scope.matches($0.group) }
        let list = q.isEmpty ? scoped : scoped.filter { $0.name.lowercased().contains(q) || $0.description.lowercased().contains(q) || $0.group.text.lowercased().contains(q) }
        // ties fall back to source group, then name, so every ordering is deterministic
        return list.sorted(using: sortOrder + [KeyPathComparator(\CatalogItem.sourceKey), KeyPathComparator(\CatalogItem.name)])
    }

    var body: some View {
        GeometryReader { geo in
            let detailWidth = min(680, max(420, geo.size.width * 0.4))
            HStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack {
                    TextField("Filter", text: $filter).textFieldStyle(.roundedBorder)
                    Picker("", selection: $scope) { ForEach(Scope.allCases) { s in Text("\(s.rawValue) \(count(s))").tag(s) } }.pickerStyle(.segmented).frame(width: 440)
                }.padding(8)
                Table(visible, selection: $selected, sortOrder: $sortOrder) {
                    TableColumn("Skill", value: \.name) { i in
                        HStack(spacing: 4) {
                            Text(i.name).foregroundStyle((i.store?.violations.isEmpty ?? true) ? Color.primary : Color.red)
                        }
                    }.width(min: 140, ideal: 180)
                    TableColumn("Source", value: \.sourceKey) { i in Text(i.group.text).foregroundStyle(groupColor(i.group)).lineLimit(1) }.width(min: 90, ideal: 160)
                    TableColumn("Listing", value: \.listingTokens) { i in Text("\(i.listingTokens)t").monospacedDigit().foregroundStyle(i.listingChars > 1536 ? .orange : .secondary) }.width(55)
                    TableColumn("Body", value: \.bodyTokens) { i in Text("\(i.bodyTokens)t").monospacedDigit().foregroundStyle(i.bodyTokens > 5000 ? .orange : .secondary) }.width(60)
                    TableColumn("Version", value: \.versionText) { i in Text(i.versionText).foregroundStyle(i.versions.count > 1 ? .red : .secondary).lineLimit(1) }.width(min: 60, ideal: 80)
                    TableColumn("Loaded on", value: \.cells) { i in Text(i.loadsText).foregroundStyle(i.loads.isEmpty ? .orange : .secondary).lineLimit(1) }.width(min: 100, ideal: 150)
                    TableColumn("Description", value: \.description) { i in Text(i.description).lineLimit(1).foregroundStyle(.secondary) }
                }
                Text("\(visible.count) shown · store \(count(.store)) · plugin skills \(count(.plugins)) · builtin \(count(.builtin)) · unmanaged \(count(.other))   ·   click a column header to sort, again to flip   ·   listing = description tokens paid every turn (orange = over Claude's 1536-char cap) · body = SKILL.md tokens paid on activation (orange > 5000t) · red version = differs across hosts")
                    .font(.caption).foregroundStyle(.secondary).padding(6)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear { if selected == nil { selected = visible.first?.id } }
            .onChange(of: model.hosts) { _, _ in if selected == nil { selected = visible.first?.id } }
            Group {
                if let item = catalog.first(where: { $0.id == selected }) {
                    if let s = item.store { SkillDetail(skill: s, item: item) } else { CatalogDetail(item: item) }
                } else {
                    ContentUnavailableView("Select a skill", systemImage: "square.stack.3d.up", description: Text("Store skills can be scoped per host × agent. Plugin, builtin and unmanaged skills show where each agent loads them."))
                }
            }
            .frame(width: detailWidth)
            .frame(maxHeight: .infinity)
            .overlay(alignment: .leading) { Divider() }
            }
        }
    }
}

func groupColor(_ g: CatalogItem.Group) -> Color {
    switch g { case .store: return .green; case .plugin: return .blue; case .builtin: return .secondary; case .other: return .orange }
}

struct StatView: View {
    let label: String; let value: String; let warn: Bool
    var body: some View {
        VStack(alignment: .leading) { Text(label).font(.caption).foregroundStyle(.secondary); Text(value).monospacedDigit().foregroundStyle(warn ? Color.orange : Color.primary) }
    }
}

struct SkillDetail: View {
    @EnvironmentObject var model: AppModel
    let skill: SkillRow
    let item: CatalogItem

    private var hosts: [String] { model.config?.hosts ?? Array(skill.targets.keys).sorted() }
    private var agents: [String] { model.config?.agents ?? [] }
    private func liveKind(host: String, agent: String) -> String? {
        model.hosts.first { $0.host == host }?.agents?[agent]?.consumed.first { $0.name == skill.name }?.kind
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                targetsBox
                loadedBox
                insightsBox
                evalBox
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(skill.name).font(.title2.bold())
            Text("store skill · ~/.skm/skills/\(skill.name)").font(.callout).foregroundStyle(.green)
            Text(skill.description).textSelection(.enabled)
            HStack(spacing: 16) {
                StatView(label: "listing", value: "\(skill.descTokens)t", warn: skill.descChars > 1536)
                StatView(label: "body", value: "\(skill.bodyTokens)t / \(skill.bodyLines) lines", warn: skill.bodyTokens > 5000)
                StatView(label: "files", value: "\(skill.files) · \(ByteCountFormatter.string(fromByteCount: Int64(skill.bytes), countStyle: .file))", warn: false)
            }
            if !skill.violations.isEmpty {
                Label(skill.violations.joined(separator: ", "), systemImage: "exclamationmark.triangle").foregroundStyle(Color.red)
            }
        }
    }

    private var targetsBox: some View {
        GroupBox("Targets (host × agent) — click to toggle") {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                GridRow {
                    Text("").frame(width: 80)
                    ForEach(agents, id: \.self) { a in Text(a).font(.caption.bold()) }
                }
                ForEach(hosts, id: \.self) { host in
                    GridRow {
                        Text(host).frame(width: 80, alignment: .leading)
                        ForEach(agents, id: \.self) { agent in cellView(host: host, agent: agent) }
                    }
                }
            }
            Text("● linked to store  ◌ wanted, not linked yet  ○ not wanted  ▣ real dir (unmanaged)  ↗ link elsewhere  ✗ broken link").font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var loadedBox: some View {
        if !item.loads.isEmpty {
            GroupBox("Loaded right now by \(item.cells) agents") {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(item.loads.keys.sorted(), id: \.self) { h in
                        ForEach(item.loads[h]!.keys.sorted(), id: \.self) { a in
                            let e = item.loads[h]![a]!
                            HStack(spacing: 10) {
                                Text("\(h)/\(a)").frame(width: 130, alignment: .leading)
                                Text(e.storage).foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
                                Text(e.owner).foregroundStyle(e.owner == "skm" ? .green : .orange).frame(width: 70, alignment: .leading)
                                Text(e.path).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                            }.font(.callout)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder private func cellView(host: String, agent: String) -> some View {
        if let wanted = skill.targets[host]?[agent] {
            cell(host: host, agent: agent, wanted: wanted)
        } else {
            Text("–").foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder private var insightsBox: some View {
        if !skill.insights.isEmpty {
            GroupBox("Insights") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(skill.insights, id: \.self) { i in Text(i).font(.callout) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder private var evalBox: some View {
        if let ev = model.evals.first(where: { $0.name == skill.name }) {
            GroupBox("LLM evaluation") {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(String(repeating: "★", count: ev.usefulness) + String(repeating: "☆", count: 5 - ev.usefulness))
                        Text("description \(ev.description_quality)/5")
                        Text(ev.verdict).bold().foregroundStyle(verdictColor(ev.verdict))
                    }
                    if !ev.overlaps.isEmpty { Text("overlaps: \(ev.overlaps.joined(separator: ", "))").foregroundStyle(Color.purple) }
                    Text(ev.reason).foregroundStyle(.secondary)
                    if !ev.trim_suggestion.isEmpty { Text("suggested: \(ev.trim_suggestion)").textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func verdictColor(_ v: String) -> Color { v == "keep" ? .green : v == "drop" ? .red : .orange }

    private func cell(host: String, agent: String, wanted: Bool) -> some View {
        let kind = liveKind(host: host, agent: agent)
        let glyph: String = kind == "managed" ? "●" : kind == "dir" ? "▣" : kind == "foreign-link" ? "↗" : kind == "broken-link" ? "✗" : wanted ? "◌" : "○"
        let color: Color = kind == "managed" ? (wanted ? .green : .orange) : kind == nil ? (wanted ? .orange : .secondary) : .orange
        return Button(glyph) { Task { await model.setScope(skill: skill.name, host: host, agent: agent, on: !wanted) } }
            .buttonStyle(.plain).foregroundStyle(color).font(.title3)
            .frame(width: 52, alignment: .leading)
            .help("\(host)/\(agent): \(wanted ? "wanted" : "not wanted")\(kind.map { " · currently \($0)" } ?? "")")
    }
}

/// Detail for a catalog row that is not in the store: a plugin skill, a Codex builtin, or an unmanaged dir/link.
struct CatalogDetail: View {
    @EnvironmentObject var model: AppModel
    let item: CatalogItem

    private var hosts: [String] { model.config?.hosts ?? item.loads.keys.sorted() }
    private var agents: [String] { model.config?.agents ?? [] }
    private var entries: [(host: String, agent: String, entry: EffectiveEntry)] {
        item.loads.keys.sorted().flatMap { h in item.loads[h]!.keys.sorted().map { a in (h, a, item.loads[h]![a]!) } }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(item.name).font(.title2.bold())
                HStack(spacing: 10) {
                    Text(item.group.text).font(.callout.bold()).foregroundStyle(groupColor(item.group))
                    if let e = entries.first?.entry { Text(e.storage).foregroundStyle(.secondary); Text("owner \(e.owner)").foregroundStyle(.secondary) }
                }
                Text(item.description.isEmpty ? "(no description)" : item.description).textSelection(.enabled)
                HStack(spacing: 16) {
                    StatView(label: "listing", value: "\(item.listingTokens)t", warn: item.listingChars > 1536)
                    StatView(label: "body", value: "\(item.bodyTokens)t", warn: item.bodyTokens > 5000)
                    StatView(label: "version", value: item.versions.isEmpty ? "–" : item.versions.joined(separator: " / "), warn: item.versions.count > 1)
                }
                GroupBox("Loaded by (host × agent)") {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                        GridRow {
                            Text("").frame(width: 80)
                            ForEach(agents, id: \.self) { a in Text(a).font(.caption.bold()) }
                        }
                        ForEach(hosts, id: \.self) { host in
                            GridRow {
                                Text(host).frame(width: 80, alignment: .leading)
                                ForEach(agents, id: \.self) { agent in
                                    if let e = item.loads[host]?[agent] {
                                        HStack(spacing: 4) {
                                            Text("●").foregroundStyle(.green)
                                            Text(e.version ?? "").font(.caption).foregroundStyle(item.versions.count > 1 ? .red : .secondary).lineLimit(1)
                                        }.frame(width: 72, alignment: .leading)
                                    } else {
                                        Text("○").foregroundStyle(.secondary).frame(width: 72, alignment: .leading)
                                    }
                                }
                            }
                        }
                    }
                    Text("● that agent loads it (version shown)  ○ it does not").font(.caption).foregroundStyle(.secondary)
                }
                GroupBox("Where it lives") {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(entries.enumerated()), id: \.offset) { _, row in
                            HStack(spacing: 10) {
                                Text("\(row.host)/\(row.agent)").frame(width: 130, alignment: .leading)
                                Text(row.entry.storage).foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
                                Text(row.entry.path).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).textSelection(.enabled)
                            }.font(.callout)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                GroupBox("How it is managed") {
                    Text(managementNote).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var managementNote: String {
        switch item.group {
        case let .plugin(p):
            return "Files stay in the plugin cache and are versioned by `claude plugin` / `codex plugin`; skm never copies them. To choose where \(p) is enabled, declare it under `plugins:` in ~/.skm/config.yaml (hosts / agents selectors) and Sync — skm then runs the plugin CLI on each host, or reports `blocked` where that CLI is missing."
        case .builtin:
            return "Shipped inside the Codex CLI (~/.codex/skills/.system) and always loaded; only a Codex update changes it."
        case let .other(o):
            return "An unmanaged real directory or a link outside the store, owned by \(o). `skm adopt <path>` moves it into the store and replaces it with a link; otherwise skm leaves it alone and keeps reporting it."
        case .store:
            return "Managed by skm."
        }
    }
}

// MARK: - Hosts

struct Chip: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text).font(.caption).padding(.horizontal, 7).padding(.vertical, 2).background(color.opacity(0.14)).foregroundStyle(color).clipShape(Capsule())
    }
}

struct HostsView: View {
    @EnvironmentObject var model: AppModel
    @State private var selection: String?   // "host/agent"

    private func agentIds(_ agents: [String: AgentStatus]) -> [String] {
        let order = model.config?.agents ?? []
        func rank(_ a: String) -> Int { order.firstIndex(of: a) ?? 99 }
        return agents.keys.sorted { a, b in rank(a) != rank(b) ? rank(a) < rank(b) : a < b }
    }
    private func plan(_ h: HostStatus) -> HostPlan? { model.plans.first { $0.host == h.host } }
    private var selected: (host: HostStatus, agent: String, status: AgentStatus)? {
        guard let sel = selection, let slash = sel.firstIndex(of: "/") else { return nil }
        let host = String(sel[..<slash]), agent = String(sel[sel.index(after: slash)...])
        guard let h = model.hosts.first(where: { $0.host == host }), let st = h.agents?[agent] else { return nil }
        return (h, agent, st)
    }
    private func autoSelect(_ hosts: [HostStatus]) {
        guard selected == nil, let h = hosts.first(where: { !($0.agents ?? [:]).isEmpty }), let a = h.agents.map(agentIds)?.first else { return }
        selection = "\(h.host)/\(a)"
    }

    var body: some View {
        GeometryReader { geo in
            let listWidth = min(780, max(560, geo.size.width * 0.45))
            HStack(spacing: 0) {
            List(selection: $selection) {
                ForEach(model.hosts) { h in
                    HostSection(h: h, plan: plan(h), agentIds: agentIds(h.agents ?? [:]))
                }
                Text("linked to store = symlink into ~/.skm/skills · real dir = unmanaged directory (e.g. acme installed by its CLI) · link elsewhere = symlink to somewhere outside the store · broken link = target missing · legacy dir = a second directory the agent also scans · builtin = shipped with Codex · from plugins = skills inside enabled plugins").font(.caption).foregroundStyle(.secondary)
            }
            .frame(width: listWidth)
            .onAppear { autoSelect(model.hosts) }
            .onChange(of: model.hosts) { _, hs in autoSelect(hs) }
            Group {
                if let s = selected {
                    AgentDetail(host: s.host, agent: s.agent, st: s.status)
                } else {
                    ContentUnavailableView("Select an agent", systemImage: "server.rack", description: Text("One row per coding agent per host. The detail lists every skill that agent loads at startup, from every source."))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .leading) { Divider() }
            }
        }
    }
}

struct HostSection: View {
    let h: HostStatus
    let plan: HostPlan?
    let agentIds: [String]
    var body: some View {
        SwiftUI.Section {
            if let e = h.error { Text(e).foregroundStyle(.red).font(.callout) }
            ForEach(agentIds, id: \.self) { a in
                if let st = h.agents?[a] { AgentRow(agent: a, st: st).tag("\(h.host)/\(a)") }
            }
        } header: {
            HostHeader(h: h, plan: plan)
        }
    }
}

struct HostHeader: View {
    let h: HostStatus
    let plan: HostPlan?
    var body: some View {
        let pending = plan?.ops.filter { mutationOps.contains($0.op) }.count ?? 0
        let blocked = plan?.ops.filter { $0.op == "blocked" }.count ?? 0
        let conflicts = plan?.ops.filter { $0.op == "conflict" }.count ?? 0
        HStack(spacing: 8) {
            Circle().fill(!h.reachable ? .red : pending > 0 ? .orange : .green).frame(width: 9, height: 9)
            Text(h.host).font(.headline).foregroundStyle(.primary)
            if let home = h.home { Text(home).foregroundStyle(.secondary) }
            if let tools = h.tools, !tools.isEmpty { Text("CLIs: " + tools.keys.sorted().joined(separator: " ")).font(.caption).foregroundStyle(.secondary) }
            Spacer()
            if let ro = h.remoteOnly, !ro.isEmpty { Text("\(ro.count) remote-only").foregroundStyle(.purple) }
            if conflicts > 0 { Text("\(conflicts) conflicts").foregroundStyle(.red) }
            if blocked > 0 { Text("\(blocked) blocked").foregroundStyle(.orange) }
            if !h.reachable { Text("unreachable").foregroundStyle(.red) } else if pending > 0 { Text("\(pending) pending").foregroundStyle(.orange) } else { Text("in sync").foregroundStyle(.green) }
        }
        .textCase(nil)
    }
}

struct AgentRow: View {
    let agent: String
    let st: AgentStatus
    var body: some View {
        let counts = Dictionary(grouping: st.consumed, by: \.kind).mapValues(\.count)
        HStack(spacing: 6) {
            Text(agent).bold().frame(width: 60, alignment: .leading)
            if !st.exists {
                Chip(text: "user dir absent", color: .secondary)
            } else {
                Chip(text: "\(counts["managed"] ?? 0) linked to store", color: .green)
                if let n = counts["dir"] { Chip(text: "\(n) real dir", color: .orange) }
                if let n = counts["foreign-link"] { Chip(text: "\(n) link elsewhere", color: .purple) }
                if let n = counts["broken-link"] { Chip(text: "\(n) broken link", color: .red) }
            }
            if let c = st.counts {
                if c.legacy > 0 { Chip(text: "\(c.legacy) legacy dir", color: .secondary) }
                if c.builtin > 0 { Chip(text: "\(c.builtin) builtin", color: .secondary) }
                if c.plugin > 0 { Chip(text: "\(c.plugin) from plugins", color: .blue) }
            }
            Spacer()
            if let c = st.counts { Text("loads \(c.total)").monospacedDigit().foregroundStyle(.secondary) }
            if let b = st.budget {
                if let budget = b.budgetTokens { Chip(text: "\(b.usedTokens)t / \(budget)t", color: b.overBy > 0 ? .red : .green) }
                else { Chip(text: "\(b.usedTokens)t", color: .secondary) }
            }
        }
        .padding(.vertical, 2)
    }
}

struct AgentDetail: View {
    let host: HostStatus
    let agent: String
    let st: AgentStatus

    private var effective: [EffectiveEntry] { st.effective ?? [] }
    private var findings: [HostFinding] { (host.findings ?? []).filter { $0.text.contains("\(host.host)/\(agent)") } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("\(host.host) / \(agent)").font(.title2.bold())
                Text(st.dir + (st.exists ? "" : "   (directory absent)")).font(.callout.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                budgetBox
                skillsBox
                pluginsBox
                findingsBox
                alsoReadsBox
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var budgetBox: some View {
        GroupBox("Startup context") {
            VStack(alignment: .leading, spacing: 6) {
                if let c = st.counts {
                    HStack(spacing: 6) {
                        Text("loads \(c.total) skills:").bold()
                        Chip(text: "user dir \(c.user)", color: .green)
                        if c.legacy > 0 { Chip(text: "legacy dir \(c.legacy)", color: .secondary) }
                        if c.builtin > 0 { Chip(text: "builtin \(c.builtin)", color: .secondary) }
                        if c.plugin > 0 { Chip(text: "plugins \(c.plugin)", color: .blue) }
                    }
                }
                if let b = st.budget {
                    if let budget = b.budgetTokens {
                        ProgressView(value: min(1, Double(b.usedTokens) / Double(max(1, budget)))).tint(b.overBy > 0 ? .red : .green)
                        Text(b.overBy > 0 ? "listing \(b.usedTokens)t of a \(budget)t budget — over by \(b.overBy)t, \(b.trimText)" : "listing \(b.usedTokens)t of a \(budget)t budget — fits")
                            .foregroundStyle(b.overBy > 0 ? .red : .green).monospacedDigit()
                    } else {
                        Text("listing \(b.usedTokens)t — \(agent) documents no listing budget").foregroundStyle(.secondary)
                    }
                    if !b.note.isEmpty { Text(b.note).font(.caption).foregroundStyle(.secondary) }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var skillsBox: some View {
        GroupBox("Skills loaded at startup (\(effective.count))") {
            if effective.isEmpty {
                Text(st.exists ? "nothing" : "no user directory").foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Table(effective) {
                    TableColumn("Skill") { e in
                        HStack(spacing: 4) { Text(e.name); if e.promptVisible == false { Text("hidden").font(.caption2).foregroundStyle(.secondary) } }
                    }.width(min: 140, ideal: 200)
                    TableColumn("Source") { e in Text(e.sourceLabel).foregroundStyle(e.source == "plugin" ? .blue : e.source == "user" ? .green : .secondary).lineLimit(1) }.width(min: 120, ideal: 250)
                    TableColumn("Storage") { e in Text(e.storage).foregroundStyle(.secondary).lineLimit(1) }.width(min: 80, ideal: 100)
                    TableColumn("Owner") { e in Text(e.owner).foregroundStyle(e.owner == "skm" ? .green : e.owner == "manual" ? .orange : .secondary).lineLimit(1) }.width(min: 90, ideal: 110)
                    TableColumn("Version") { e in Text(e.version ?? "–").foregroundStyle(.secondary).lineLimit(1) }.width(80)
                    TableColumn("Listing") { e in Text("\(e.listingTokens ?? 0)t").monospacedDigit().foregroundStyle(e.listingChars > 1536 ? .orange : .secondary) }.width(60)
                    TableColumn("Body") { e in Text("\(e.bodyTokens)t").monospacedDigit().foregroundStyle(e.bodyTokens > 5000 ? .orange : .secondary) }.width(65)
                }
                .frame(height: CGFloat(min(28, effective.count)) * 24 + 32)
                Text("source = where the agent finds it (user dir · legacy dir · builtin · plugin@marketplace) · storage = how it is stored (link→store, real dir, plugin cache, builtin) · owner = who writes it · implicit = Codex plugin cached without a config.toml entry")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var pluginsBox: some View {
        if let ps = st.plugins, !ps.isEmpty {
            GroupBox("Plugins (\(ps.count))") {
                Table(ps) {
                    TableColumn("Plugin") { (p: PluginStatus) in Text(p.name) }.width(min: 120, ideal: 170)
                    TableColumn("Marketplace") { (p: PluginStatus) in Text(p.marketplace) }.width(min: 120, ideal: 170)
                    TableColumn("State") { (p: PluginStatus) in Text(p.enabled).foregroundStyle(p.enabled == "off" ? Color.secondary : Color.green) }.width(70)
                    TableColumn("Version") { (p: PluginStatus) in Text(p.version ?? "–").lineLimit(1) }.width(90)
                    TableColumn("Skills") { (p: PluginStatus) in Text("\(p.skills.count)").monospacedDigit() }.width(50)
                    TableColumn("Cached versions") { (p: PluginStatus) in Text(p.cachedVersions.joined(separator: ", ")).foregroundStyle(p.cachedVersions.count > 1 ? .orange : .secondary).lineLimit(1) }
                }
                .frame(height: CGFloat(min(12, ps.count)) * 24 + 32)
                Text("off = cached but disabled (still on disk) · more than one cached version = stale cache").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var findingsBox: some View {
        if !findings.isEmpty {
            GroupBox("Findings (\(findings.count))") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(findings) { f in
                        HStack(alignment: .top) {
                            Text(f.kind).font(.caption.bold()).foregroundStyle(f.kind == "version-drift" ? .red : f.kind.hasPrefix("same") || f.kind == "linked-twice" ? .orange : .secondary).frame(width: 110, alignment: .leading)
                            Text(f.text).font(.callout).textSelection(.enabled)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder private var alsoReadsBox: some View {
        let extra = st.alsoReads.filter { !$0.value.isEmpty }
        if !extra.isEmpty {
            GroupBox("Also reads") {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(extra.keys.sorted(), id: \.self) { dir in
                        Text("\(dir): \(extra[dir]!.joined(separator: " "))").font(.callout).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// MARK: - Sync

struct SyncView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VSplitView {
            VStack(alignment: .leading) {
                HStack {
                    Text("Plan").font(.headline)
                    Spacer()
                    Toggle("Replace conflicts (move real dirs into the backup, then link)", isOn: $model.replaceConflicts)
                    Button("Backup") { Task { await model.backup() } }.disabled(model.busy != nil)
                    Button("Sync now") { Task { await model.sync() } }.buttonStyle(.borderedProminent).disabled(model.busy != nil)
                }.padding(8)
                List(model.plans) { p in
                    DisclosureGroup {
                        ForEach(Array(p.ops.enumerated()), id: \.offset) { _, op in
                            Text(op.text).foregroundStyle(op.op == "conflict" ? .red : op.op == "remote-only" ? .purple : op.op == "blocked" ? .orange : .primary).font(.callout.monospaced())
                        }
                    } label: {
                        HStack {
                            Circle().fill(p.reachable ? .green : .red).frame(width: 8, height: 8)
                            Text(p.host).bold()
                            let muts = p.ops.filter { mutationOps.contains($0.op) }.count
                            let blocked = p.ops.filter { $0.op == "blocked" }.count
                            let conf = p.ops.filter { $0.op == "conflict" }.count
                            Text(p.reachable ? "\(muts) mutations\(conf > 0 ? ", \(conf) conflicts" : "")\(blocked > 0 ? ", \(blocked) blocked" : "")" : p.error ?? "unreachable").foregroundStyle(.secondary)
                        }
                    }
                }
            }
            VStack(alignment: .leading) {
                Text("Log").font(.headline).padding(8)
                ScrollViewReader { proxy in
                    List(Array(model.log.enumerated()), id: \.offset) { i, line in
                        Text(line).font(.callout.monospaced()).id(i)
                    }
                    .onChange(of: model.log.count) { _, n in if n > 0 { proxy.scrollTo(n - 1) } }
                }
            }
            .frame(minHeight: 160)
        }
    }
}

// MARK: - Insights

struct InsightsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let d = model.doctor {
                GroupBox("Startup context per host × agent") {
                    Table(d.budget) {
                        TableColumn("Host", value: \.host).width(90)
                        TableColumn("Agent", value: \.agent).width(80)
                        TableColumn("Skills") { Text("\($0.skills)") }.width(60)
                        TableColumn("Listing") { r in Text("\(r.usedTokens)t").monospacedDigit() }.width(140)
                        TableColumn("Budget") { r in Text(r.budgetTokens.map { "\($0)t" } ?? "—").monospacedDigit() }.width(80)
                        TableColumn("Verdict") { r in
                            if r.budgetTokens == nil { Text("no documented budget").foregroundStyle(.secondary) }
                            else if r.overBy > 0 { Text("over by \(r.overBy)t → \(r.trimText)").foregroundStyle(.red) }
                            else { Text("fits").foregroundStyle(.green) }
                        }
                    }
                    .frame(height: CGFloat(min(12, d.budget.count)) * 26 + 30)
                    Text("tokens by each agent's own accounting · counts every skill the agent loads (user dir, legacy dir, builtins, enabled plugins) · Claude: 1% of its model window (chars ÷ chars/token), 1536-char cap per skill · Codex: 2% of its model window · fallback window \(d.contextTokens) tokens when a model is unknown").font(.caption).foregroundStyle(.secondary)
                }.padding(8)
                if let f = d.findings, !f.isEmpty {
                    GroupBox("Cross-source findings (\(f.count))") {
                        Table(f) {
                            TableColumn("Kind") { x in Text(x.kind).foregroundStyle(x.kind == "version-drift" ? .red : x.kind.hasPrefix("same") || x.kind == "linked-twice" ? .orange : .secondary) }.width(120)
                            TableColumn("Where") { x in Text([x.host, x.agent].compactMap { $0 }.joined(separator: "/")) }.width(110)
                            TableColumn("Detail") { x in Text(x.text).lineLimit(2) }
                        }
                        .frame(height: CGFloat(min(8, f.count)) * 26 + 30)
                    }.padding(8)
                }
            }
            HStack {
                Text("LLM evaluation").font(.headline)
                Text("(\(model.evals.count) cached)").foregroundStyle(.secondary)
                Spacer()
                Button("Evaluate uncached") { Task { await model.evaluate(fresh: false) } }.disabled(model.busy != nil)
                Button("Re-evaluate all") { Task { await model.evaluate(fresh: true) } }.disabled(model.busy != nil)
            }.padding(8)
            Table(model.evals.sorted { $0.usefulness < $1.usefulness }) {
                TableColumn("Skill", value: \.name).width(200)
                TableColumn("Useful") { e in Text(String(repeating: "★", count: e.usefulness) + String(repeating: "☆", count: 5 - e.usefulness)).foregroundStyle(e.usefulness <= 2 ? .red : e.usefulness == 3 ? .orange : .green) }.width(70)
                TableColumn("Desc") { e in Text("\(e.description_quality)/5") }.width(50)
                TableColumn("Verdict") { e in Text(e.verdict).foregroundStyle(e.verdict == "keep" ? .green : e.verdict == "drop" ? .red : .orange) }.width(60)
                TableColumn("Overlaps") { e in Text(e.overlaps.joined(separator: ", ")).foregroundStyle(.purple) }.width(160)
                TableColumn("Reason") { e in Text(e.reason).lineLimit(2) }
            }
            if let d = model.doctor {
                Text("Heuristics (\(d.insights.count))").font(.headline).padding(8)
                Table(d.insights) {
                    TableColumn("Kind", value: \.kind).width(130)
                    TableColumn("Skill", value: \.skill).width(200)
                    TableColumn("Detail", value: \.detail)
                }
            }
        }
    }
}
