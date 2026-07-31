import Foundation
import Speech
import AVFoundation

/**
 * iPadOS 26 engine: SpeechAnalyzer + SpeechTranscriber. Fully on-device,
 * with word-level audio time ranges — the source of the speech-to-swap
 * metric. No vocabulary API exists on this path (SFSpeechRecognizer's
 * contextualStrings has no SpeechTranscriber equivalent); loanword
 * handling relies on aliases + the matcher's all-but-one rule.
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
        let locale = Locale(identifier: localeId)
        let supported = await SpeechTranscriber.supportedLocales
        guard supported.contains(where: {
            $0.identifier(.bcp47) == locale.identifier(.bcp47)
        }) else {
            throw NSError(domain: "NativeSpeech", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "SpeechTranscriber does not support \(localeId)",
            ])
        }

        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        self.transcriber = transcriber

        // download the on-device model if this locale needs it
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            plugin?.emitStatus("starting", detail: "downloading speech model")
            try await install.downloadAndInstall()
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = continuation

        let input = audioEngine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        let converter: AVAudioConverter? = {
            guard let target = targetFormat, target != inFormat else { return nil }
            return AVAudioConverter(from: inFormat, to: target)
        }()

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
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
            self.inputBuilder?.yield(AnalyzerInput(buffer: out))
        }
        audioEngine.prepare()
        try audioEngine.start()

        plugin?.setSessionStart(epochMs: Date().timeIntervalSince1970 * 1000)
        plugin?.emitStatus("listening", detail: "analyzer")

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
