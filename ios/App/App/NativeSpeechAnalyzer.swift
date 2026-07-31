import Foundation
import Speech
import AVFoundation

/**
 * iPadOS 26 engine: SpeechAnalyzer + SpeechTranscriber. Fully on-device,
 * with word-level audio time ranges — the source of the speech-to-swap
 * metric. No vocabulary API exists on this path; loanword handling
 * relies on aliases + the matcher's all-but-one rule.
 *
 * B.2 silence sprint:
 *  - one isolation domain: the class is @MainActor with an explicit
 *    state machine; audio-thread work crosses over only through
 *    Sendable AsyncStream continuations (no Timer, no ad-hoc hops)
 *  - hardware gate: empty/missing SpeechTranscriber support skips the
 *    engine with a single env note (AnalyzerUnsupported) — no
 *    AssetInventory calls, no error spam — straight to the recognizer
 *  - AssetInventory is used only on capable hardware, in Apple's
 *    documented order: create module → assetInstallationRequest
 *    (supporting:) → downloadAndInstall — status is never queried bare
 */
@available(iOS 26.0, *)
@MainActor
final class NativeSpeechAnalyzer {
    private enum State {
        case idle
        case preparing
        case running
        case stopped
    }

    private weak var plugin: NativeSpeechPlugin?
    private let localeId: String
    private let audioEngine = AVAudioEngine()
    private var state: State = .idle
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var levelBuilder: AsyncStream<Float>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var analyzeTask: Task<Void, Never>?
    private var levelTask: Task<Void, Never>?
    private var progressTask: Task<Void, Never>?
    private var finalizedWords: [String] = []
    private var finalizedEnds: [Double] = []

    init(plugin: NativeSpeechPlugin, localeId: String) {
        self.plugin = plugin
        self.localeId = localeId
    }

    /// Throws AnalyzerUnsupported for a clean fallback; anything else is
    /// a real failure the plugin reports loudly.
    func start() async throws {
        guard state == .idle else { return } // idempotent
        state = .preparing

        let requested = Locale(identifier: localeId)
        let supportedList = await SpeechTranscriber.supportedLocales
        let installedList = await SpeechTranscriber.installedLocales
        let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: requested)

        // Dictation lists recorded alongside for the hardware verdict
        let dictSupported = await DictationTranscriber.supportedLocales.map { $0.identifier }
        let dictInstalled = await DictationTranscriber.installedLocales.map { $0.identifier }

        let resolvedInSupported = resolved.map { r in
            supportedList.contains { $0.identifier(.bcp47) == r.identifier(.bcp47) }
        } ?? false

        var env: [String: Any] = [
            "engine": "analyzer",
            "locale": resolved?.identifier ?? requested.identifier,
            "resolvedSupported": resolvedInSupported,
            "onDevice": true,
            "supported": supportedList.map { $0.identifier },
            "installed": installedList.map { $0.identifier },
            "dictationSupported": dictSupported,
            "dictationInstalled": dictInstalled,
            "onDeviceByLocale": plugin?.onDeviceProbe() ?? [:],
        ]

        // Hardware gate: a device whose SpeechTranscriber support list
        // is empty (or excludes the resolved locale) cannot run this
        // engine — skip cleanly, exactly one env note.
        guard let resolved = resolved, resolvedInSupported, !supportedList.isEmpty else {
            env["engine"] = "analyzer-unsupported"
            env["note"] = "analyzer: hardware unsupported"
            plugin?.emitEnv(env)
            state = .stopped
            throw AnalyzerUnsupported(note: "SpeechTranscriber unsupported on this hardware/locale")
        }

        env.merge(plugin?.sessionEnvFields() ?? [:]) { a, _ in a }
        plugin?.emitEnv(env)

        let transcriber = SpeechTranscriber(
            locale: resolved,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        self.transcriber = transcriber

        // Supported ≠ installed: download the model on first use, with
        // progress surfaced to the status strip. Documented order only.
        let isInstalled = installedList.contains {
            $0.identifier(.bcp47) == resolved.identifier(.bcp47)
        }
        if !isInstalled {
            if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                plugin?.emitStatus("model-progress", detail: "0")
                let progress = install.progress
                progressTask = Task { [weak self] in
                    while !Task.isCancelled {
                        let pct = Int(progress.fractionCompleted * 100)
                        self?.plugin?.emitStatus("model-progress", detail: String(pct))
                        try? await Task.sleep(nanoseconds: 500_000_000)
                    }
                }
                defer {
                    progressTask?.cancel()
                    progressTask = nil
                }
                try await install.downloadAndInstall()
                plugin?.emitStatus("model-progress", detail: "100")
            }
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])

        do {
            _ = try plugin?.configureAudioSession()
        } catch {
            state = .stopped
            throw error
        }

        let (audioStream, audioContinuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = audioContinuation
        let (levelStream, levelContinuation) = AsyncStream<Float>.makeStream()
        levelBuilder = levelContinuation

        let input = audioEngine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
            state = .stopped
            plugin?.emitStatus("error", detail: "microphone reports an invalid audio format (\(inFormat.sampleRate) Hz)")
            throw AnalyzerUnsupported(note: "invalid input format")
        }
        let converter: AVAudioConverter? = {
            guard let target = targetFormat, target != inFormat else { return nil }
            return AVAudioConverter(from: inFormat, to: target)
        }()

        plugin?.armListeningConfirmation(detail: "analyzer")

        // The tap runs on the audio thread. It touches ONLY the two
        // Sendable continuations; RMS math is a static pure function.
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { buffer, _ in
            levelContinuation.yield(NativeSpeechPlugin.rms(of: buffer))
            var out: AVAudioPCMBuffer = buffer
            if let converter = converter, let target = targetFormat {
                let ratio = target.sampleRate / inFormat.sampleRate
                let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
                guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
                var convError: NSError?
                let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
                    outStatus.pointee = .haveData
                    return buffer
                }
                converter.convert(to: converted, error: &convError, withInputFrom: inputBlock)
                if convError != nil { return }
                out = converted
            }
            audioContinuation.yield(AnalyzerInput(buffer: out))
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            state = .stopped
            plugin?.emitStatus("error", detail: "audio engine failed: \(error.localizedDescription)")
            throw error
        }

        plugin?.setSessionStart(epochMs: Date().timeIntervalSince1970 * 1000)
        state = .running

        // level + listening confirmation, consumed inside the actor
        levelTask = Task { [weak self] in
            for await rms in levelStream {
                guard let self = self, self.state == .running else { break }
                self.plugin?.reportLevel(rms: rms)
            }
        }
        resultsTask = Task { [weak self] in
            guard let self = self, let transcriber = self.transcriber else { return }
            do {
                for try await result in transcriber.results {
                    guard self.state == .running else { break }
                    self.handle(result)
                }
            } catch {
                self.plugin?.emitStatus("error", detail: "analyzer results: \(error.localizedDescription)")
            }
        }
        analyzeTask = Task { [weak self] in
            guard let self = self, let analyzer = self.analyzer else { return }
            do {
                try await analyzer.start(inputSequence: audioStream)
            } catch {
                self.plugin?.emitStatus("error", detail: "analyzer start: \(error.localizedDescription)")
            }
        }
    }

    private func handle(_ result: SpeechTranscriber.Result) {
        var words: [String] = []
        var ends: [Double] = []
        let text = result.text
        for run in text.runs {
            let piece = String(text[run.range].characters)
            let runEnd: Double? = run.audioTimeRange.map { $0.end.seconds * 1000 }
            for w in piece.split(separator: " ") where !w.isEmpty {
                words.append(String(w))
                ends.append(runEnd ?? ends.last ?? 0)
            }
        }
        if result.isFinal {
            finalizedWords.append(contentsOf: words)
            finalizedEnds.append(contentsOf: ends)
            plugin?.emitWords(finalizedWords, ends: finalizedEnds, isFinal: true, engine: "analyzer")
        } else {
            plugin?.emitWords(finalizedWords + words, ends: finalizedEnds + ends, isFinal: false, engine: "analyzer")
        }
    }

    func stop() {
        guard state != .stopped else { return } // idempotent
        state = .stopped
        progressTask?.cancel()
        progressTask = nil
        inputBuilder?.finish()
        inputBuilder = nil
        levelBuilder?.finish()
        levelBuilder = nil
        resultsTask?.cancel()
        analyzeTask?.cancel()
        levelTask?.cancel()
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        let analyzer = self.analyzer
        Task { try? await analyzer?.finalizeAndFinishThroughEndOfInput() }
        self.analyzer = nil
        self.transcriber = nil
    }
}
