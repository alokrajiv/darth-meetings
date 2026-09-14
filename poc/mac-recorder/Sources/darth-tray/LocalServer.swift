import Foundation
import Network
import RecorderCore

/// WebSocket server on 127.0.0.1 for the Meetings PWA. Chrome treats loopback as a
/// potentially-trustworthy origin, so an https page may open ws://127.0.0.1 without
/// mixed-content complaints. TODO: pairing token + Origin allow-list before this leaves POC.
final class LocalServer {
    let port: NWEndpoint.Port
    private var listener: NWListener?
    private var conns: [NWConnection] = []
    private let queue = DispatchQueue(label: "darth.localserver")
    /// Called on the main queue.
    var onCommand: ((String, [String: Any]) -> Void)?
    /// Called on the main queue; returns the snapshot sent to a freshly connected client.
    var statusProvider: (() -> [String: Any])?
    /// Called on the main queue whenever the client count changes.
    var onClientsChanged: ((Int) -> Void)?

    init(port: UInt16) { self.port = NWEndpoint.Port(rawValue: port)! }

    func start() throws {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params)
        l.stateUpdateHandler = { st in rlog("local server ws://127.0.0.1:\(self.port): \(st)") }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.start(queue: queue)
        listener = l
    }

    private func accept(_ c: NWConnection) {
        conns.append(c)
        notifyClients()
        c.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            switch st {
            case .ready:
                rlog("ws client connected (\(self.conns.count) total)")
                DispatchQueue.main.async {
                    var snap = self.statusProvider?() ?? [:]
                    snap["type"] = "status"
                    self.queue.async { self.send(snap, to: c) }
                }
            case .failed(let e):
                rlog("ws client failed: \(e)"); self.remove(c)
            case .cancelled:
                self.remove(c)
            default: break
            }
        }
        c.start(queue: queue)
        receive(c)
    }

    private func remove(_ c: NWConnection) {
        if let i = conns.firstIndex(where: { $0 === c }) {
            conns.remove(at: i)
            c.cancel()
            rlog("ws client gone (\(conns.count) left)")
            notifyClients()
        }
    }

    private func notifyClients() {
        let n = conns.count
        DispatchQueue.main.async { self.onClientsChanged?(n) }
    }

    private func receive(_ c: NWConnection) {
        c.receiveMessage { [weak self] data, ctx, _, err in
            guard let self else { return }
            if err != nil { self.remove(c); return }
            if let md = ctx?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                switch md.opcode {
                case .close:
                    self.remove(c); return
                case .text, .binary:
                    if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let cmd = obj["cmd"] as? String {
                        DispatchQueue.main.async { self.onCommand?(cmd, obj) }
                    }
                default: break
                }
            }
            self.receive(c)
        }
    }

    private func send(_ obj: [String: Any], to c: NWConnection) {
        guard c.state == .ready, let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        let md = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "text", metadata: [md])
        c.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
    }

    func broadcast(_ obj: [String: Any]) {
        queue.async { for c in self.conns { self.send(obj, to: c) } }
    }
}
