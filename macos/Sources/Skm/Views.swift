import SwiftUI

// MARK: - Skills

struct SkillsView: View {
    @EnvironmentObject var model: AppModel
    @State private var selected: String?
    @State private var filter = ""
    @State private var sortByCost = false

    private var visible: [SkillRow] {
        let q = filter.lowercased()
        let list = q.isEmpty ? model.skills : model.skills.filter { $0.name.lowercased().contains(q) || $0.description.lowercased().contains(q) }
        return sortByCost ? list.sorted { $0.descChars > $1.descChars } : list.sorted { $0.name < $1.name }
    }

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                HStack {
                    TextField("Filter", text: $filter).textFieldStyle(.roundedBorder)
                    Toggle("by cost", isOn: $sortByCost).toggleStyle(.checkbox)
                }.padding(8)
                Table(visible, selection: $selected) {
                    TableColumn("Skill") { s in
                        Text(s.name).foregroundStyle(s.violations.isEmpty ? Color.primary : Color.red)
                    }.width(min: 160, ideal: 220)
                    TableColumn("Listing") { s in Text("\(s.descChars)c · \(s.descTokens)t").monospacedDigit().foregroundStyle(s.descChars > 1536 ? .orange : .secondary) }.width(110)
                    TableColumn("Body") { s in Text("\(s.bodyTokens)t · \(s.bodyLines)L").monospacedDigit().foregroundStyle(s.bodyTokens > 5000 ? .orange : .secondary) }.width(110)
                    TableColumn("Files") { s in Text("\(s.files)").monospacedDigit() }.width(45)
                    TableColumn("Description") { s in Text(s.description).lineLimit(1).foregroundStyle(.secondary) }
                }
                Text("\(visible.count) skills · listing = description chars/tokens, paid every turn · body = SKILL.md tokens/lines, paid on activation")
                    .font(.caption).foregroundStyle(.secondary).padding(6)
            }
            .frame(minWidth: 480)
            Group {
                if let s = model.skills.first(where: { $0.name == selected }) { SkillDetail(skill: s) } else { ContentUnavailableView("Select a skill", systemImage: "square.stack.3d.up") }
            }
            .frame(minWidth: 380)
        }
    }
}

struct SkillDetail: View {
    @EnvironmentObject var model: AppModel
    let skill: SkillRow

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
            Text(skill.description).textSelection(.enabled)
            HStack(spacing: 16) {
                stat("listing", "\(skill.descChars)c ≈ \(skill.descTokens)t", warn: skill.descChars > 1536)
                stat("body", "\(skill.bodyTokens)t / \(skill.bodyLines) lines", warn: skill.bodyTokens > 5000)
                stat("files", "\(skill.files) · \(ByteCountFormatter.string(fromByteCount: Int64(skill.bytes), countStyle: .file))", warn: false)
            }
            if !skill.violations.isEmpty {
                Label(skill.violations.joined(separator: ", "), systemImage: "exclamationmark.triangle").foregroundStyle(Color.red)
            }
        }
    }

    private var targetsBox: some View {
        GroupBox("Targets (host × agent)") {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                GridRow {
                    Text("").frame(width: 90)
                    ForEach(agents, id: \.self) { a in Text(a).font(.caption.bold()) }
                }
                ForEach(hosts, id: \.self) { host in
                    GridRow {
                        Text(host).frame(width: 90, alignment: .leading)
                        ForEach(agents, id: \.self) { agent in cellView(host: host, agent: agent) }
                    }
                }
            }
            Text("● linked  ◌ wanted, not linked yet  ○ not wanted  ▣ real dir  ↗ foreign link  — click to toggle").font(.caption).foregroundStyle(.secondary)
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

    private func stat(_ label: String, _ value: String, warn: Bool) -> some View {
        VStack(alignment: .leading) { Text(label).font(.caption).foregroundStyle(.secondary); Text(value).monospacedDigit().foregroundStyle(warn ? Color.orange : Color.primary) }
    }

    private func cell(host: String, agent: String, wanted: Bool) -> some View {
        let kind = liveKind(host: host, agent: agent)
        let glyph: String = kind == "managed" ? "●" : kind == "dir" ? "▣" : kind == "foreign-link" ? "↗" : kind == "broken-link" ? "✗" : wanted ? "◌" : "○"
        let color: Color = kind == "managed" ? (wanted ? .green : .orange) : kind == nil ? (wanted ? .orange : .secondary) : .orange
        return Button(glyph) { Task { await model.setScope(skill: skill.name, host: host, agent: agent, on: !wanted) } }
            .buttonStyle(.plain).foregroundStyle(color).font(.title3)
            .frame(width: 60, alignment: .leading)
            .help("\(host)/\(agent): \(wanted ? "wanted" : "not wanted")\(kind.map { " · currently \($0)" } ?? "")")
    }
}

// MARK: - Hosts

struct HostsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        List(model.hosts) { h in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Circle().fill(h.reachable ? .green : .red).frame(width: 9, height: 9)
                    Text(h.host).font(.headline)
                    if let home = h.home { Text(home).foregroundStyle(.secondary) }
                    Spacer()
                    if let ro = h.remoteOnly, !ro.isEmpty { Text("\(ro.count) remote-only").foregroundStyle(.purple) }
                    if let d = h.drift, !d.isEmpty { Text("\(d.count) pending").foregroundStyle(.orange) } else if h.reachable { Text("in sync").foregroundStyle(.green) }
                }
                if let e = h.error { Text(e).foregroundStyle(.red).font(.callout) }
                if let agents = h.agents {
                    ForEach(agents.keys.sorted(), id: \.self) { a in
                        let st = agents[a]!
                        HStack(alignment: .top) {
                            Text(a).frame(width: 70, alignment: .leading).bold()
                            if st.exists {
                                let counts = Dictionary(grouping: st.consumed, by: \.kind).mapValues(\.count)
                                Text("● \(counts["managed"] ?? 0)").foregroundStyle(.green)
                                if let n = counts["dir"] { Text("▣ \(n)").foregroundStyle(.orange) }
                                if let n = counts["foreign-link"] { Text("↗ \(n)").foregroundStyle(.purple) }
                                if let n = counts["broken-link"] { Text("✗ \(n)").foregroundStyle(.red) }
                                let legacy = st.alsoReads.values.flatMap { $0 }
                                if !legacy.isEmpty { Text("legacy dir: \(legacy.count)").foregroundStyle(.secondary) }
                                Text(st.consumed.map(\.name).joined(separator: " ")).foregroundStyle(.secondary).lineLimit(2).font(.callout)
                            } else { Text("absent").foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            .padding(.vertical, 6)
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
                            Text(op.text).foregroundStyle(op.op == "conflict" ? .red : op.op == "remote-only" ? .purple : .primary).font(.callout.monospaced())
                        }
                    } label: {
                        HStack {
                            Circle().fill(p.reachable ? .green : .red).frame(width: 8, height: 8)
                            Text(p.host).bold()
                            let muts = p.ops.filter { ["mkdir", "rsync-skill", "link", "unlink"].contains($0.op) }.count
                            let conf = p.ops.filter { $0.op == "conflict" }.count
                            Text(p.reachable ? "\(muts) mutations\(conf > 0 ? ", \(conf) conflicts" : "")" : p.error ?? "unreachable").foregroundStyle(.secondary)
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
                        TableColumn("Listing") { Text("\($0.usedChars)c ≈ \($0.tokens)t").monospacedDigit() }.width(140)
                        TableColumn("Budget") { r in Text(r.budgetChars.map { "\($0)c" } ?? "—").monospacedDigit() }.width(80)
                        TableColumn("Verdict") { r in
                            if r.budgetChars == nil { Text("no documented budget").foregroundStyle(.secondary) }
                            else if r.overBy > 0 { Text("over by \(r.overBy)c → ~\(r.droppedCount) descriptions dropped").foregroundStyle(.red) }
                            else { Text("fits").foregroundStyle(.green) }
                        }
                    }
                    .frame(height: CGFloat(min(12, d.budget.count)) * 26 + 30)
                    Text("context window assumed \(d.contextTokens) tokens · Claude: 1% listing budget, 1536c per skill · Codex: 2%").font(.caption).foregroundStyle(.secondary)
                }.padding(8)
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
