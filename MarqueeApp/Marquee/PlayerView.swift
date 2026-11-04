import AppKit
import AVKit
import SwiftUI

/// The player window: the system video player (AVPlayerView) with resume and progress saving.
struct PlayerWindow: View {
    @EnvironmentObject private var model: AppModel
    let request: PlaybackRequest
    @StateObject private var controller = PlayerController()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            SystemPlayerView(player: controller.player)
                .ignoresSafeArea()

            if let message = controller.errorMessage {
                PlaybackErrorView(message: message, url: request.url)
            } else if controller.isBuffering {
                ProgressView()
                    .controlSize(.large)
                    .allowsHitTesting(false)
            }
        }
        .navigationTitle(request.windowTitle)
        .onAppear { controller.start(request, model: model) }
        .onDisappear { controller.stop() }
        .onChange(of: request) { _, newValue in controller.start(newValue, model: model) }
    }
}

private struct PlaybackErrorView: View {
    let message: String
    let url: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 36))
                .foregroundStyle(.yellow)
            Text("This video can't play here")
                .font(.title2.weight(.semibold))
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
            Text("The built-in player handles MP4, MOV and HLS. For MKV, AVI and other formats, open it in another player such as IINA or VLC.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
            HStack {
                if let link = URL(string: url) {
                    Button("Open in Default App") { NSWorkspace.shared.open(link) }
                        .buttonStyle(.borderedProminent)
                }
                Button("Copy Link") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                }
            }
        }
        .padding(32)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct SystemPlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .floating
        view.showsFullScreenToggleButton = true
        view.allowsPictureInPicturePlayback = true
        view.videoGravity = .resizeAspect
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player { view.player = player }
    }
}

@MainActor
final class PlayerController: ObservableObject {
    let player = AVPlayer()
    @Published var errorMessage: String?
    @Published var isBuffering = true

    private var request: PlaybackRequest?
    private weak var model: AppModel?
    private var resumeAt: Double?
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var bufferObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?

    func start(_ request: PlaybackRequest, model: AppModel) {
        if self.request == request, player.currentItem != nil { return }
        stop()
        self.request = request
        self.model = model
        errorMessage = nil
        isBuffering = true

        guard let url = URL(string: request.url) else {
            errorMessage = "The link for this video is not valid."
            return
        }

        if let saved = model.progress[request.videoId], !saved.isFinished, saved.position > 10 {
            resumeAt = max(0, saved.position - 3)
        } else {
            resumeAt = nil
        }

        let item = AVPlayerItem(url: url)
        statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            let status = item.status
            let error = item.error
            Task { @MainActor in self?.handle(status: status, error: error) }
        }
        bufferObservation = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
            let waiting = player.timeControlStatus == .waitingToPlayAtSpecifiedRate
            Task { @MainActor in self?.isBuffering = waiting }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.saveProgress(ended: true) }
        }
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.saveProgress() }
        }

        player.replaceCurrentItem(with: item)
        player.play()
    }

    private func handle(status: AVPlayerItem.Status, error: Error?) {
        switch status {
        case .readyToPlay:
            if let resumeAt {
                player.seek(to: CMTime(seconds: resumeAt, preferredTimescale: 600))
                self.resumeAt = nil
            }
        case .failed:
            isBuffering = false
            errorMessage = error?.localizedDescription ?? "The video could not be loaded."
        default:
            break
        }
    }

    private func saveProgress(ended: Bool = false) {
        guard let request, let model, let item = player.currentItem else { return }
        let duration = item.duration.seconds
        guard duration.isFinite, duration > 0 else { return }
        let position = ended ? duration : player.currentTime().seconds
        guard position.isFinite, position > 0 else { return }
        model.updateProgress(for: request, position: position, duration: duration)
    }

    func stop() {
        saveProgress()
        player.pause()
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        timeObserver = nil
        endObserver = nil
        statusObservation = nil
        bufferObservation = nil
        player.replaceCurrentItem(with: nil)
        request = nil
    }
}
