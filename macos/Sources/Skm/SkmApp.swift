import SwiftUI

@main
struct SkmApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("skm") {
            RootView().environmentObject(model)
                .frame(minWidth: 1120, minHeight: 700)
                .task { await model.refreshAll() }
        }
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Refresh") { Task { await model.refreshAll() } }.keyboardShortcut("r")
                Button("Sync…") { model.section = .sync }.keyboardShortcut("s")
            }
        }
        Settings { SettingsView().environmentObject(model) }
    }
}

enum Section: String, CaseIterable, Identifiable {
    case skills, hosts, sync, insights
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var icon: String {
        switch self {
        case .skills: return "square.stack.3d.up"
        case .hosts: return "server.rack"
        case .sync: return "arrow.triangle.2.circlepath"
        case .insights: return "lightbulb"
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var section: Section = .skills
    @Published var skills: [SkillRow] = []
    @Published var hosts: [HostStatus] = []
    @Published var plans: [HostPlan] = []
    @Published var doctor: DoctorReport?
    @Published var evals: [EvalItem] = []
    @Published var config: ConfigSummary?
    @Published var log: [String] = []
    @Published var busy: String?
    @Published var error: String?
    @Published var replaceConflicts = false

    private let engine = Engine.shared

    init() { Snapshot.scheduleIfRequested(self) }

    func refreshAll() async {
        await load("loading skills") { self.config = try await self.engine.config(); self.skills = try await self.engine.skills() }
        await load("checking hosts") {
            // status and plan each probe the hosts (concurrently); doctor then reads the probe status cached, no third round-trip
            async let status = self.engine.status()
            async let plans = self.engine.plan()
            self.hosts = try await status
            self.plans = try await plans
            self.doctor = try await self.engine.doctor(cached: true)
            self.evals = (try? await self.engine.evals()) ?? []
        }
    }

    func refreshHosts() async {
        await load("checking hosts") { self.hosts = try await self.engine.status(); self.plans = try await self.engine.plan() }
    }

    func setScope(skill: String, host: String, agent: String, on: Bool) async {
        await load("saving") {
            try await self.engine.setScope(skill: skill, host: host, agent: agent, on: on)
            self.skills = try await self.engine.skills()
            self.plans = try await self.engine.plan()
        }
    }

    func runStream(_ label: String, _ stream: AsyncThrowingStream<String, Error>) async {
        busy = label; error = nil
        log.append("▶ \(label)")
        do {
            for try await line in stream { log.append(line) }
            log.append("✓ \(label) finished")
        } catch { self.error = error.localizedDescription; log.append("✗ \(error.localizedDescription)") }
        busy = nil
    }

    func sync() async {
        await runStream("sync", engine.sync(replaceConflicts: replaceConflicts))
        await refreshHosts()
    }
    func backup() async { await runStream("backup", engine.backup()) }
    func evaluate(fresh: Bool) async {
        await runStream("eval", engine.evaluate(fresh: fresh))
        await load("eval results") { self.evals = try await self.engine.evals() }
    }

    private func load(_ label: String, _ body: @escaping () async throws -> Void) async {
        busy = label; error = nil
        do { try await body() } catch { self.error = error.localizedDescription }
        busy = nil
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationSplitView {
            List(Section.allCases, selection: $model.section) { s in
                Label(s.title, systemImage: s.icon).tag(s)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
            .safeAreaInset(edge: .bottom) { hostChips }
        } detail: {
            Group {
                switch model.section {
                case .skills: SkillsView()
                case .hosts: HostsView()
                case .sync: SyncView()
                case .insights: InsightsView()
                }
            }
            .toolbar {
                ToolbarItemGroup {
                    if let busy = model.busy { ProgressView().controlSize(.small); Text(busy).foregroundStyle(.secondary) }
                    Button { Task { await model.refreshAll() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(model.busy != nil)
                    Button { model.section = .sync } label: { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }
                }
            }
        }
        .alert("skm", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
    }

    private var hostChips: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(model.hosts) { h in
                let plan = model.plans.first { $0.host == h.host }
                let pending = plan?.ops.filter { mutationOps.contains($0.op) }.count ?? 0
                let blocked = plan?.ops.filter { $0.op == "blocked" }.count ?? 0
                let conflicts = plan?.ops.filter { $0.op == "conflict" }.count ?? 0
                HStack(spacing: 6) {
                    Circle().fill(!h.reachable ? .red : pending > 0 ? .yellow : .green).frame(width: 8, height: 8)
                    Text(h.host).font(.callout)
                    if pending > 0 { Text("+\(pending)").font(.caption).foregroundStyle(.orange) }
                    if conflicts > 0 { Text("!\(conflicts)").font(.caption).foregroundStyle(.red) }
                    if blocked > 0 { Text("⊘\(blocked)").font(.caption).foregroundStyle(.orange) }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SettingsView: View {
    @AppStorage("skmCommand") private var skmCommand = ""
    var body: some View {
        Form {
            TextField("skm command", text: $skmCommand, prompt: Text("~/.local/bin/skm   or   bun run /path/to/skill-manager/bin/skm.ts"))
            Text("Leave empty to search ~/.local/bin, /opt/homebrew/bin, /usr/local/bin.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 560)
    }
}
