import Foundation
import AVFoundation
import MediaPlayer
import Combine
import UIKit

enum RepeatMode: Int {
    case off, all, one
}

/// Owns the AVPlayer. Because the audio session category is `.playback` and the app declares the
/// `audio` background mode, music keeps playing with the screen locked or the app in the background.
final class PlayerManager: NSObject, ObservableObject {
    @Published private(set) var queue: [Track] = []
    @Published private(set) var index: Int = -1
    @Published private(set) var isPlaying = false
    @Published private(set) var isBuffering = false
    @Published var currentTime: Double = 0
    @Published var duration: Double = 0
    @Published var shuffle = false
    @Published var repeatMode: RepeatMode = .off
    @Published var showNowPlaying = false
    @Published var message: String?

    weak var library: LibraryStore?

    private let player = AVPlayer()
    private var bag = Set<AnyCancellable>()
    private var itemBag = Set<AnyCancellable>()
    private var history: [Int] = []
    private var failureStreak = 0

    var current: Track? { queue.indices.contains(index) ? queue[index] : nil }

    override init() {
        super.init()
        player.automaticallyWaitsToMinimizeStalling = true
        configureSession()
        observePlayer()
        setupRemoteCommands()
        observeSession()
    }

    // MARK: Audio session (this is what enables background playback)

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
    }

    private func observePlayer() {
        player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                guard let self = self else { return }
                self.isPlaying = status != .paused
                self.isBuffering = status == .waitingToPlayAtSpecifiedRate
                self.updateNowPlaying()
            }
            .store(in: &bag)

        _ = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            guard let self = self, time.seconds.isFinite else { return }
            self.currentTime = time.seconds
            if let d = self.player.currentItem?.duration.seconds, d.isFinite, d > 0 { self.duration = d }
        }
    }

    private func observeSession() {
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self = self,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began {
                self.player.pause()
            } else if let opt = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
                      AVAudioSession.InterruptionOptions(rawValue: opt).contains(.shouldResume) {
                try? AVAudioSession.sharedInstance().setActive(true)
                self.player.play()
            }
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            self?.player.pause()   // headphones unplugged
        }
    }

    // MARK: Queue control

    func play(_ tracks: [Track], startAt start: Int) {
        guard tracks.indices.contains(start) else { return }
        queue = tracks
        history = []
        index = start
        failureStreak = 0
        load()
    }

    func playNext(_ track: Track) {
        if queue.isEmpty { play([track], startAt: 0) } else { queue.insert(track, at: index + 1); message = "Playing next" }
    }

    func addToQueue(_ track: Track) {
        if queue.isEmpty { play([track], startAt: 0) } else { queue.append(track); message = "Added to queue" }
    }

    func jump(to i: Int) {
        guard queue.indices.contains(i) else { return }
        history.append(index)
        index = i
        load()
    }

    private func load() {
        guard let track = current, let url = Catalog.streamURL(for: track) else { handleFailure(); return }
        itemBag.removeAll()
        let item = AVPlayerItem(url: url)

        item.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self, weak item] status in
                guard let self = self, let item = item else { return }
                if status == .readyToPlay {
                    self.failureStreak = 0
                    if item.duration.seconds.isFinite { self.duration = item.duration.seconds }
                    self.updateNowPlaying()
                } else if status == .failed {
                    self.handleFailure()
                }
            }
            .store(in: &itemBag)

        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: item)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.trackEnded() }
            .store(in: &itemBag)

        currentTime = 0
        duration = track.duration
        player.replaceCurrentItem(with: item)
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play()
        library?.addRecent(track)
        updateNowPlaying(reloadArtwork: true)
    }

    private func handleFailure() {
        failureStreak += 1
        if let t = current { message = "Couldn't play \"\(t.title)\"" }
        if queue.count > 1 && failureStreak < queue.count {
            advance(auto: true)
        } else {
            player.pause()
        }
    }

    private func trackEnded() {
        if repeatMode == .one {
            seek(to: 0)
            player.play()
        } else {
            advance(auto: true)
        }
    }

    func next() { advance(auto: false) }

    private func advance(auto: Bool) {
        guard !queue.isEmpty else { return }
        var n = index + 1
        if shuffle && queue.count > 1 {
            repeat { n = Int.random(in: 0..<queue.count) } while n == index
        }
        if n >= queue.count {
            if repeatMode == .all || !auto {
                n = 0
            } else {
                player.pause()
                seek(to: 0)
                return
            }
        }
        history.append(index)
        index = n
        load()
    }

    func previous() {
        if currentTime > 3 || queue.count < 2 { seek(to: 0); return }
        if let last = history.popLast() {
            index = last
        } else {
            index = index > 0 ? index - 1 : queue.count - 1
        }
        load()
    }

    func togglePlay() {
        if player.timeControlStatus == .paused {
            try? AVAudioSession.sharedInstance().setActive(true)
            if player.currentItem == nil { load() } else { player.play() }
        } else {
            player.pause()
        }
    }

    func resume() { if player.timeControlStatus == .paused { togglePlay() } }
    func pause() { player.pause() }

    func seek(to seconds: Double) {
        let t = max(0, seconds)
        player.seek(to: CMTime(seconds: t, preferredTimescale: 600))
        currentTime = t
        updateNowPlaying()
    }

    func cycleRepeat() {
        repeatMode = RepeatMode(rawValue: (repeatMode.rawValue + 1) % 3) ?? .off
    }

    // MARK: Lock screen / Control Center

    private func setupRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.resume(); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.togglePlay(); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in self?.next(); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in self?.previous(); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(to: e.positionTime)
            return .success
        }
    }

    private func updateNowPlaying(reloadArtwork: Bool = false) {
        guard let t = current else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyTitle] = t.title
        info[MPMediaItemPropertyArtist] = t.artist
        info[MPMediaItemPropertyPlaybackDuration] = duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        if reloadArtwork { info[MPMediaItemPropertyArtwork] = nil }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        guard reloadArtwork, let url = t.artworkURL else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data, let image = UIImage(data: data) else { return }
            let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                guard self.current?.id == t.id else { return }
                var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                updated[MPMediaItemPropertyArtwork] = art
                MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
            }
        }.resume()
    }
}
