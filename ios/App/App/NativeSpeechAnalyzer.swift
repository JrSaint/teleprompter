import Foundation
import Speech
import AVFoundation

/**
 * iPadOS 26 engine: SpeechAnalyzer + SpeechTranscriber. Fully on-device,
 * with word-level audio time ranges — the source of the speech-to-swap
 * metric. No vocabulary API exists on this path; loanword handling
 * relies on aliases + the matcher's all-but-one rule.
 *
 * B.2 bugfix sprint:
 *  - locale resolution uses Apple's equivalence API, never string
 *    comparison of BCP-47 tags (supported lists use en_US-style ids)
 *  - supported ≠ installed: missing language models are downloaded via
 *    AssetInventory with progress surfaced as "model-progress" events
 *    (first use needs network; the UI copy says so)
 *  - "listening" only after the first audio buffer; level metering and
 *    every failure path emit status events
 */
@available(iOS 26.0, *)
final class NativeSpeechAnalyzer {
    private weak var plugin: NativeSpeechPlugin?
    private let localeId: String
    private let audioEngine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var analyzeTask: Task<Void, Never>?
    private var progressTimer: Timer?
    private var finalizedWords: [String] = []
    private var finalizedEnds: [Double] = []

    init(plugin: NativeSpeechPlugin, localeId: String) {
        self.plugin = plugin
        self.localeId = localeId
    }

    /// completion(false) → caller falls back to SFSpeechRecognizer.
    func start(completion: @escaping (Bool) -> Void) {
        Task {
            do {
                try await self.run()
                completion(true)
            } catch {
                self.plugin?.emitStatus("error", detail: "analyzer: \(error.localizedDescription)")
                completion(false)
            }
        }
    }

    private func run() async throws {
        let requested = Locale(identifier: localeId)

        // Locale resolution via Apple's equivalence API — supported
        // locales use underscore identifiers (en_US); never compare tags
        let supportedList = await SpeechTranscriber.supportedLocales
        let installedList = await SpeechTranscriber.installedLocales
        guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
            plugin?.emitEnv(engine: "analyzer-rejected",
                            resolvedLocale: requested.identifier,
                            onDevice: true,
                            supported: supportedList.map { $0.identifier },
                            installed: installedList.map { $0.identifier })
            throw NSError(domain: "NativeSpeech", code: 1, userInfo: [
                NSLocalizedDescriptionKey:
                    "SpeechTranscriber has no locale equivalent to \(localeId)",
            ])
        }

        let transcriber = SpeechTranscriber(
            locale: resolved,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        self.transcriber = transcriber

        let isInstalled = installedList.contains {
            $0.identifier(.bcp47) == resolved.identifier(.bcp47)
        }
        plugin?.emitEnv(engine: "analyzer",
                        resolvedLocale: resolved.identifier,
                        onDevice: true,
                        supported: supportedList.map { $0.identifier },
                        installed: installedList.map { $0.identifier })

        // Supported ≠ installed: download the model on first use, with
        // progress surfaced to the status strip.
        if !isInstalled {
            if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                plugin?.emitStatus("model-progress", detail: "0")
                let progress = install.progress
                await MainActor.run {
                    self.progressTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                        let pct = Int(progress.fractionCompleted * 100)
                        self?.plugin?.emitStatus("model-progress", detail: String(pct))
                    }
                }
                defer {
                    Task { @MainActor in
                        self.progressTimer?.invalidate()
                        self.progressTimer = nil
                    }
                }
                try await install.downloadAndInstall()
                plugin?.emitStatus("model-progress", detail: "100")
            }
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            plugin?.emitStatus("error", detail: "audio session failed: \(error.localizedDescription)")
            throw error
        }

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = continuation

        let input = audioEngine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
            plugin?.emitStatus("error", detail: "microphone reports an invalid audio format (\(inFormat.sampleRate) Hz)")
            throw NSError(domain: "NativeSpeech", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "invalid input format",
            ])
        }
        let converter: AVAudioConverter? = {
            guard let target = targetFormat, target != inFormat else { return nil }
            return AVAudioConverter(from: inFormat, to: target)
        }()

        plugin?.armListeningConfirmation(detail: "analyzer")
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.plugin?.onTapBuffer(buffer)
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
                if let convError = convError {
                    self.plugin?.emitStatus("error", detail: "audio conversion: \(convError.localizedDescription)")
                    return
                }
                out = converted
            }
            self.inputBuilder?.yield(AnalyzerInput(buffer: out))
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            plugin?.emitStatus("error", detail: "audio engine failed: \(error.localizedDescription)")
            throw error
        }

        plugin?.setSessionStart(epochMs: Date().timeIntervalSince1970 * 1000)

        resultsTask = Task { [weak self] in
            guard let self = self, let transcriber = self.transcriber else { return }
            do {
                for try await result in transcriber.results {
                    self.handle(result)
                }
            } catch {
                self.plugin?.emitStatus("error", detail: "analyzer results: \(error.localizedDescription)")
            }
        }
        analyzeTask = Task { [weak self] in
            guard let self = self, let analyzer = self.analyzer else { return }
            do {
                try await analyzer.start(inputSequence: stream)
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
        progressTimer?.invalidate()
        progressTimer = nil
        inputBuilder?.finish()
        inputBuilder = nil
        resultsTask?.cancel()
        analyzeTask?.cancel()
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        let analyzer = self.analyzer
        Task { try? await analyzer?.finalizeAndFinishThroughEndOfInput() }
        self.analyzer = nil
        self.transcriber = nil
    }
}
